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
  date: z.string(),
  title: z.string().min(1),
  event_type: z.enum(['holiday', 'meeting']).default('holiday'),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  description: z.string().optional(),
  created_by: z.string().uuid().optional(),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const { start_date, end_date, event_type, page = '1', limit = '50' } = req.query;
  let query = supabase.from('calendar_events').select('*, creator:users(full_name, email)', { count: 'exact' });
  if (start_date) query = query.gte('date', start_date);
  if (end_date) query = query.lte('date', end_date);
  if (event_type) query = query.eq('event_type', event_type);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('date', { ascending: true });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('calendar_events').select('*, creator:users(full_name, email)').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  const parsed = schema.safeParse({ ...req.body, created_by: userId });
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('calendar_events').insert(parsed.data).select('*, creator:users(full_name, email)').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('calendar_events').update(parsed.data).eq('id', req.params.id).select('*, creator:users(full_name, email)').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('calendar_events').delete().eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerCalendarRoutes(api: express.Router) {
  api.use('/calendar', router);
}
