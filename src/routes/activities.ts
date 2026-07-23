import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

export const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note'] as const;
export const ACTIVITY_ENTITY_TYPES = [
  'lead',
  'opportunity',
  'enquiry',
  'quotation',
  'buyer',
  'vendor',
  'contact',
  'company',
  'job',
  'project',
  'partnership',
] as const;
export const ACTIVITY_OUTCOMES = [
  'connected',
  'no_answer',
  'voicemail',
  'completed',
  'cancelled',
  'other',
] as const;

const createSchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  entity_type: z.enum(ACTIVITY_ENTITY_TYPES),
  entity_id: z.string().uuid(),
  subject: z.string().trim().min(1),
  notes: z.string().optional().nullable(),
  activity_date: z.string().optional().nullable(),
  outcome: z.enum(ACTIVITY_OUTCOMES).optional().nullable(),
});

const updateSchema = createSchema.partial().omit({ entity_type: true, entity_id: true });

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

/** Enrich a list of records with last_activity_at + days_since_last_activity */
export async function attachLastActivityStats<T extends { id: string }>(
  entityType: (typeof ACTIVITY_ENTITY_TYPES)[number],
  records: T[],
): Promise<
  Array<
    T & {
      last_activity_at: string | null;
      days_since_last_activity: number | null;
    }
  >
> {
  if (!records.length) return [];

  const ids = records.map((r) => r.id);
  const { data, error } = await supabase
    .from('activities')
    .select('entity_id, activity_date')
    .eq('entity_type', entityType)
    .in('entity_id', ids)
    .order('activity_date', { ascending: false });

  const latest = new Map<string, string>();
  if (!error) {
    for (const row of data || []) {
      if (!latest.has(row.entity_id)) {
        latest.set(row.entity_id, row.activity_date);
      }
    }
  }

  return records.map((r) => {
    const last = latest.get(r.id) || null;
    return {
      ...r,
      last_activity_at: last,
      days_since_last_activity: daysSince(last),
    };
  });
}

// GET /api/activities?entity_type=&entity_id=
router.get('/', async (req, res) => {
  const { entity_type, entity_id, type, page = '1', limit = '50' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);

  let query = supabase
    .from('activities')
    .select(
      '*, creator:users!activities_created_by_fkey(id, full_name)',
      { count: 'exact' },
    );

  if (entity_type) query = query.eq('entity_type', String(entity_type));
  if (entity_id) query = query.eq('entity_id', String(entity_id));
  if (type && type !== 'all') query = query.eq('type', String(type));

  query = query.order('activity_date', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) {
    // Fallback without join if FK name differs
    let fb = supabase.from('activities').select('*', { count: 'exact' });
    if (entity_type) fb = fb.eq('entity_type', String(entity_type));
    if (entity_id) fb = fb.eq('entity_id', String(entity_id));
    if (type && type !== 'all') fb = fb.eq('type', String(type));
    fb = fb.order('activity_date', { ascending: false }).range((p - 1) * l, p * l - 1);
    const r = await fb;
    if (r.error) return res.status(500).json({ error: r.error.message });
    return res.json({
      data: r.data || [],
      total: r.count || 0,
      page: p,
      limit: l,
      totalPages: Math.ceil((r.count || 0) / l),
    });
  }

  res.json({
    data: data || [],
    total: count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

// GET /api/activities/last?entity_type=&entity_ids=id1,id2
router.get('/last', async (req, res) => {
  const entityType = String(req.query.entity_type || '');
  const idsRaw = String(req.query.entity_ids || '');
  const ids = idsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!entityType || !ids.length) {
    return res.status(400).json({ error: 'entity_type and entity_ids required' });
  }

  const stub = ids.map((id) => ({ id }));
  const enriched = await attachLastActivityStats(
    entityType as (typeof ACTIVITY_ENTITY_TYPES)[number],
    stub,
  );
  res.json({ data: enriched });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('activities')
    .select('*, creator:users!activities_created_by_fkey(id, full_name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const payload = {
    ...parsed.data,
    notes: parsed.data.notes?.trim() || null,
    outcome: parsed.data.outcome || null,
    activity_date: parsed.data.activity_date || new Date().toISOString(),
    created_by: userId,
  };

  const { data, error } = await supabase
    .from('activities')
    .insert(payload)
    .select('*, creator:users!activities_created_by_fkey(id, full_name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const { data: existing } = await supabase
    .from('activities')
    .select('id, created_by')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const privileged = role === 'manager' || role === 'super_admin';
  if (!privileged && existing.created_by !== userId) {
    return res.status(403).json({ error: 'You can only edit activities you created' });
  }

  const { data, error } = await supabase
    .from('activities')
    .update({
      ...parsed.data,
      notes: parsed.data.notes !== undefined ? parsed.data.notes?.trim() || null : undefined,
    })
    .eq('id', req.params.id)
    .select('*, creator:users!activities_created_by_fkey(id, full_name)')
    .single();

  if (error || !data) return res.status(404).json({ error: error?.message || 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  const { data: existing } = await supabase
    .from('activities')
    .select('id, created_by')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const privileged = role === 'manager' || role === 'super_admin';
  if (!privileged && existing.created_by !== userId) {
    return res.status(403).json({ error: 'You can only delete activities you created' });
  }

  const { error } = await supabase.from('activities').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerActivityRoutes(api: express.Router) {
  api.use('/activities', router);
}
