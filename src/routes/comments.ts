import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

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

router.get('/', async (req, res) => {
  const { related_table, related_id, page = '1', limit = '20' } = req.query;
  let query = supabase.from('comments').select('*, author:users(full_name, email)', { count: 'exact' }).is('deleted_at', null);
  if (related_table) query = query.eq('related_table', related_table);
  if (related_id) query = query.eq('related_id', related_id);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: true });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('comments').select('*, author:users(full_name, email)').eq('id', req.params.id).is('deleted_at', null).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  const parsed = schema.safeParse({ ...req.body, author_id: userId });
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('comments').insert(parsed.data).select('*, author:users(full_name, email)').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('comments').update(parsed.data).eq('id', req.params.id).eq('author_id', userId).is('deleted_at', null).select('*, author:users(full_name, email)').single();
  if (error || !data) return res.status(404).json({ error: 'Not found or unauthorized' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const userId = req.user?.id;
  const userRole = req.user?.role;
  const { data, error } = await supabase.from('comments').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerCommentRoutes(api: express.Router) {
  api.use('/comments', router);
}
