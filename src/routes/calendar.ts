import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { sharedWriteGuard } from '../middleware/requireRole.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

const schema = z.object({
  date: z.string(),
  title: z.string().min(1),
  event_type: z.enum(['holiday', 'meeting', 'company_event', 'training', 'deadline']).default('holiday'),
  start_time: z.string().optional().nullable(),
  end_time: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  all_day: z.boolean().optional(),
  status: z.enum(['active', 'cancelled']).optional(),
  holiday_pay_type: z.enum(['paid', 'unpaid']).optional().nullable(),
  created_by: z.string().uuid().optional(),
});

const updateSchema = schema.partial();

const CREATOR_SELECT = '*, creator:users!created_by(full_name, email)';

function friendlyDbError(message: string): string {
  const m = String(message || '').toLowerCase();
  if (m.includes('more than one relationship') || m.includes('could not embed')) {
    return 'Could not save the event. Please try again.';
  }
  if (m.includes('row-level security')) {
    return 'You do not have permission to do that.';
  }
  if (m.includes('duplicate') || m.includes('unique')) {
    return 'An event with these details already exists.';
  }
  return 'Something went wrong. Please try again.';
}

router.get('/', async (req, res) => {
  const { start_date, end_date, event_type, page = '1', limit = '50' } = req.query;
  let query = supabase.from('calendar_events').select(CREATOR_SELECT, { count: 'exact' });
  if (start_date) query = query.gte('date', start_date);
  if (end_date) query = query.lte('date', end_date);
  if (event_type) query = query.eq('event_type', event_type);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('date', { ascending: true });
  let { data, count, error } = await query;
  if (error && /relationship|embed/i.test(error.message)) {
    let fallback = supabase.from('calendar_events').select('*', { count: 'exact' });
    if (start_date) fallback = fallback.gte('date', start_date);
    if (end_date) fallback = fallback.lte('date', end_date);
    if (event_type) fallback = fallback.eq('event_type', event_type);
    fallback = fallback.range((p - 1) * l, p * l - 1).order('date', { ascending: true });
    ({ data, count, error } = await fallback);
  }
  if (error) return res.status(500).json({ error: friendlyDbError(error.message) });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

/** Calendar feed: calendar_events + approved leaves merged into one list. */
router.get('/feed', async (req, res) => {
  const { start_date, end_date } = req.query;

  let eventsQuery = supabase.from('calendar_events').select(CREATOR_SELECT);
  if (start_date) eventsQuery = eventsQuery.gte('date', start_date as string);
  if (end_date) eventsQuery = eventsQuery.lte('date', end_date as string);

  let leavesQuery = supabase
    .from('leave_requests')
    .select('id, requested_by, start_date, end_date, reason, status')
    .eq('status', 'approved');
  if (start_date) leavesQuery = leavesQuery.gte('end_date', start_date as string);
  if (end_date) leavesQuery = leavesQuery.lte('start_date', end_date as string);

  let [eventsRes, leavesRes] = await Promise.all([eventsQuery, leavesQuery]);
  if (eventsRes.error && /relationship|embed/i.test(eventsRes.error.message)) {
    let fallback = supabase.from('calendar_events').select('*');
    if (start_date) fallback = fallback.gte('date', start_date as string);
    if (end_date) fallback = fallback.lte('date', end_date as string);
    eventsRes = await fallback;
  }
  if (eventsRes.error) return res.status(500).json({ error: friendlyDbError(eventsRes.error.message) });
  if (leavesRes.error) return res.status(500).json({ error: friendlyDbError(leavesRes.error.message) });

  const leaves = leavesRes.data || [];
  const userIds = Array.from(new Set(leaves.map((l) => l.requested_by)));
  let names: Record<string, string> = {};
  if (userIds.length) {
    const { data: users } = await supabase.from('users').select('id, full_name, email').in('id', userIds);
    names = (users || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
      acc[u.id] = u.full_name || u.email || 'Employee';
      return acc;
    }, {});
  }

  const leaveEvents = leaves.map((l) => ({
    id: `leave-${l.id}`,
    date: l.start_date,
    title: `Leave — ${names[l.requested_by] || 'Employee'}`,
    event_type: 'leave' as const,
    start_date: l.start_date,
    end_date: l.end_date,
    description: l.reason,
    is_leave: true,
  }));

  res.json({ data: [...(eventsRes.data || []), ...leaveEvents] });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('calendar_events').select(CREATOR_SELECT).eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Event not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  const parsed = schema.safeParse({ ...req.body, created_by: userId });
  if (!parsed.success) return res.status(400).json({ error: 'Please check the event details and try again.', issues: parsed.error.issues });
  const { data, error } = await supabase.from('calendar_events').insert(parsed.data).select('*').single();
  if (error) return res.status(500).json({ error: friendlyDbError(error.message) });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check the event details and try again.', issues: parsed.error.issues });
  const { data, error } = await supabase.from('calendar_events').update(parsed.data).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Event not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('calendar_events').delete().eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Event not found' });
  res.json({ success: true });
});

export function registerCalendarRoutes(api: express.Router) {
  api.use('/calendar', router);
}
