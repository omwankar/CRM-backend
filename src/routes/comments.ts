import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { notifySuperAdmins } from '../lib/notifyAdmins.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const schema = z.object({
  body: z.string().min(1),
  author_id: z.string().uuid(),
  related_table: z.string().min(1),
  related_id: z.string().uuid(),
  parent_id: z.string().uuid().optional(),
});

const updateSchema = z.object({
  body: z.string().min(1),
});

function missingColumn(message: string) {
  const match =
    String(message || '').match(/Could not find the '([^']+)' column/i) ||
    String(message || '').match(/column (?:[\w.]+\.)?([a-zA-Z0-9_]+) does not exist/i);
  return match?.[1] || null;
}

function friendlyCommentError(message: string) {
  const m = String(message || '').toLowerCase();
  if (m.includes('foreign key') || m.includes('violates')) {
    return 'Could not save the comment. Please try again.';
  }
  if (m.includes('relationship') || m.includes('schema cache') || m.includes('embed')) {
    return 'Could not save the comment. Please try again.';
  }
  return 'Could not save the comment. Please try again.';
}

type CommentRow = Record<string, unknown> & {
  id?: string;
  author_id?: string | null;
};

async function withAuthors<T extends CommentRow>(rows: T[]): Promise<Array<T & { author: { full_name?: string; email?: string } | null }>> {
  const ids = Array.from(new Set(rows.map((r) => r.author_id).filter(Boolean))) as string[];
  let usersMap: Record<string, { full_name?: string; email?: string }> = {};
  if (ids.length) {
    const { data: users } = await supabase.from('users').select('id, full_name, email').in('id', ids);
    usersMap = (users || []).reduce(
      (acc: Record<string, { full_name?: string; email?: string }>, u: { id: string; full_name?: string; email?: string }) => {
        acc[u.id] = { full_name: u.full_name, email: u.email };
        return acc;
      },
      {},
    );
  }
  return rows.map((r) => ({
    ...r,
    author: r.author_id ? usersMap[r.author_id] || null : null,
  }));
}

async function insertComment(payload: Record<string, unknown>) {
  let attempt: Record<string, unknown> = { ...payload };
  for (let i = 0; i < 8; i++) {
    const { data, error } = await supabase.from('comments').insert(attempt).select('*').single();
    if (!error) return { data, error: null as null };
    const col = missingColumn(error.message || '');
    if (col && col in attempt) {
      const { [col]: _removed, ...rest } = attempt;
      attempt = rest;
      continue;
    }
    return { data: null, error };
  }
  return { data: null, error: { message: 'Could not save the comment. Please try again.' } };
}

router.get('/', async (req, res) => {
  const { related_table, related_id, page = '1', limit = '20' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));

  const run = async (withDeletedAt: boolean) => {
    let query = supabase.from('comments').select('*', { count: 'exact' });
    if (withDeletedAt) query = query.is('deleted_at', null);
    if (related_table) query = query.eq('related_table', String(related_table));
    if (related_id) query = query.eq('related_id', String(related_id));
    return query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: true });
  };

  let { data, count, error } = await run(true);
  if (error && missingColumn(error.message || '') === 'deleted_at') {
    ({ data, count, error } = await run(false));
  }
  if (error && /created_at/i.test(error.message || '')) {
    let query = supabase.from('comments').select('*', { count: 'exact' });
    if (related_table) query = query.eq('related_table', String(related_table));
    if (related_id) query = query.eq('related_id', String(related_id));
    ({ data, count, error } = await query.range((p - 1) * l, p * l - 1));
  }
  if (error) return res.status(500).json({ error: friendlyCommentError(error.message) });

  const rows = await withAuthors(data || []);
  res.json({ data: rows, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('comments').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  const [row] = await withAuthors([data]);
  res.json(row);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  const parsed = schema.safeParse({ ...req.body, author_id: userId });
  if (!parsed.success) return res.status(400).json({ error: 'Please write a comment and try again.', issues: parsed.error.issues });

  const { data, error } = await insertComment(parsed.data);
  if (error || !data) return res.status(500).json({ error: friendlyCommentError(error?.message || '') });

  const actor = req.user?.full_name || req.user?.email || 'Someone';
  try {
    await notifySuperAdmins(
      'comment',
      'New comment',
      `${actor} commented on ${parsed.data.related_table}.`,
    );
  } catch {
    /* comment is already saved */
  }

  const [row] = await withAuthors([data]);
  res.status(201).json(row);
});

router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please write a comment and try again.', issues: parsed.error.issues });
  const { data, error } = await supabase
    .from('comments')
    .update(parsed.data)
    .eq('id', req.params.id)
    .eq('author_id', userId)
    .select('*')
    .single();
  if (error || !data) return res.status(404).json({ error: 'Not found or unauthorized' });
  const [row] = await withAuthors([data]);
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data: existing } = await supabase
    .from('comments')
    .select('id, author_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const canManage = role === 'manager' || role === 'super_admin' || role === 'admin';
  if (!canManage && existing.author_id !== userId) {
    return res.status(403).json({ error: 'You can only delete your own comments' });
  }

  const { data, error } = await supabase
    .from('comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error && missingColumn(error.message || '') === 'deleted_at') {
    const hard = await supabase.from('comments').delete().eq('id', req.params.id).select().single();
    if (hard.error || !hard.data) return res.status(404).json({ error: 'Not found' });
    return res.json({ success: true });
  }

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerCommentRoutes(api: express.Router) {
  api.use('/comments', router);
}
