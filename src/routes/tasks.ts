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
  title: z.string().min(1),
  description: z.string().optional(),
  assigned_to: z.string().uuid().optional(),
  created_by: z.string().uuid(),
  related_table: z.string().optional(),
  related_id: z.string().uuid().optional(),
  due_date: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).default('open'),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const userId = req.user?.id;
  const userRole = req.user?.role;
  const { assigned_to, status, priority, related_table, related_id, page = '1', limit = '20' } = req.query;

  let query = supabase.from('tasks').select('*, assignee:users(full_name, email), creator:users(full_name, email)', { count: 'exact' }).is('deleted_at', null);

  // Non-admins only see their assigned tasks
  if (!['super_admin', 'admin', 'manager'].includes(userRole || '')) {
    query = query.eq('assigned_to', userId);
  } else if (assigned_to) {
    query = query.eq('assigned_to', assigned_to);
  }

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (related_table) query = query.eq('related_table', related_table);
  if (related_id) query = query.eq('related_id', related_id);

  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('tasks').select('*, assignee:users(full_name, email), creator:users(full_name, email)').eq('id', req.params.id).is('deleted_at', null).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  const parsed = schema.safeParse({ ...req.body, created_by: userId });
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('tasks').insert(parsed.data).select('*, assignee:users(full_name, email), creator:users(full_name, email)').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('tasks').update(parsed.data).eq('id', req.params.id).is('deleted_at', null).select('*, assignee:users(full_name, email), creator:users(full_name, email)').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerTaskRoutes(api: express.Router) {
  api.use('/tasks', router);
}
