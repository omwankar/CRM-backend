import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { computeWorkingDays, getHolidayDatesInRange, getLeaveUsage } from '../lib/leave.js';
import { computeEmployeeMonthAttendance } from '../lib/attendanceCompute.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const clockInSchema = z.object({
  notes: z.string().optional(),
});

const clockOutSchema = z.object({
  notes: z.string().optional(),
});

const missedPunchSchema = z.object({
  type: z.enum(['clock_in', 'clock_out']),
  requested_at: z.string(),
  reason: z.string().optional(),
});

const leaveSubmitSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  reason: z.string().optional(),
});

async function notifyLeave(userId: string, title: string, message: string) {
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'leave',
    title,
    message,
  });
}

// GET /leave-requests — current user's leave requests
router.get('/leave-requests', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('leave_requests')
    .select('id, start_date, end_date, reason, leave_type, working_days, status, reviewed_at, created_at')
    .eq('requested_by', userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// GET /leave-balance — current user's paid-leave balance for a calendar year
router.get('/leave-balance', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const year = Number(req.query.year) || new Date().getFullYear();
  try {
    const usage = await getLeaveUsage(supabase, userId, year);
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load balance' });
  }
});

// GET /attendance/me — current user's own day-wise attendance for a month
router.get('/attendance/me', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  try {
    const attendance = await computeEmployeeMonthAttendance(supabase, userId, month);
    res.json(attendance);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load attendance' });
  }
});

// POST /leave-requests — submit leave (all authenticated users)
router.post('/leave-requests', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = leaveSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  if (parsed.data.end_date < parsed.data.start_date) {
    return res.status(400).json({ error: 'End date must be on or after start date' });
  }

  const { data: profile } = await supabase
    .from('users')
    .select('employee_id')
    .eq('id', userId)
    .maybeSingle();

  // Auto-classify: count working days (skip weekends + holidays), then decide
  // paid vs unpaid against the remaining balance. If the balance can't cover the
  // whole request, the entire request is unpaid.
  const holidayDates = await getHolidayDatesInRange(
    supabase,
    parsed.data.start_date,
    parsed.data.end_date,
  );
  const workingDays = computeWorkingDays(parsed.data.start_date, parsed.data.end_date, holidayDates);
  const year = Number(parsed.data.start_date.slice(0, 4)) || new Date().getFullYear();
  const usage = await getLeaveUsage(supabase, userId, year);
  const leaveType = workingDays > 0 && workingDays <= usage.remaining ? 'paid' : 'unpaid';

  const { data, error } = await supabase
    .from('leave_requests')
    .insert({
      requested_by: userId,
      employee_id: profile?.employee_id || null,
      start_date: parsed.data.start_date,
      end_date: parsed.data.end_date,
      reason: parsed.data.reason,
      leave_type: leaveType,
      working_days: workingDays,
      status: 'pending',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// GET /sessions — list current user's sessions
router.get('/sessions', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('clock_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('clock_in', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /sessions/current — get active session if any
router.get('/sessions/current', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('clock_sessions')
    .select('*')
    .eq('user_id', userId)
    .is('clock_out', null)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// POST /clock-in
router.post('/clock-in', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = clockInSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('clock_sessions')
    .insert({
      user_id: userId,
      clock_in: new Date().toISOString(),
      notes: parsed.data.notes,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// POST /clock-out
router.post('/clock-out', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = clockOutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('clock_sessions')
    .update({
      clock_out: new Date().toISOString(),
      notes: parsed.data.notes,
    })
    .eq('user_id', userId)
    .is('clock_out', null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'No active session found' });
  res.json(data);
});

// GET /missed-punch-requests
router.get('/missed-punch-requests', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('missed_punch_requests')
    .select('*, reviewer:users(full_name, email)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /missed-punch-requests
router.post('/missed-punch-requests', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = missedPunchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('missed_punch_requests')
    .insert({
      user_id: userId,
      ...parsed.data,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Helper: require super_admin
function requireSuperAdmin(req: express.Request, res: express.Response): boolean {
  if (req.user?.role !== 'super_admin') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// GET /punch-requests — list all punch requests (super_admin only)
router.get('/punch-requests', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const { status = 'pending', page = '1', limit = '20', search } = req.query;
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));

  let query = supabase
    .from('missed_punch_requests')
    .select('*, user:users!missed_punch_requests_user_id_fkey(id, full_name, email, avatar_url), reviewer:users!missed_punch_requests_reviewed_by_fkey(full_name)', { count: 'exact' });

  if (status !== 'all') query = query.eq('status', status as string);
  query = query.order('created_at', { ascending: false });
  query = query.range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Get pending count
  const { count: pendingCount } = await supabase
    .from('missed_punch_requests')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  res.json({ data, total: count, page: p, limit: l, pending_count: pendingCount || 0 });
});

// GET /punch-requests/stats (super_admin only)
router.get('/punch-requests/stats', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const today = new Date().toISOString().split('T')[0];

  const [pending, approvedToday, rejectedToday] = await Promise.all([
    supabase.from('missed_punch_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('missed_punch_requests').select('*', { count: 'exact', head: true }).eq('status', 'approved').gte('reviewed_at', today),
    supabase.from('missed_punch_requests').select('*', { count: 'exact', head: true }).eq('status', 'rejected').gte('reviewed_at', today),
  ]);

  res.json({
    pending: pending.count || 0,
    approved_today: approvedToday.count || 0,
    rejected_today: rejectedToday.count || 0,
  });
});

// PUT /punch-requests/:id/approve (super_admin only)
router.put('/punch-requests/:id/approve', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  // Get the punch request
  const { data: request, error: fetchError } = await supabase
    .from('missed_punch_requests')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (fetchError || !request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });

  // Update the request
  const { data, error } = await supabase
    .from('missed_punch_requests')
    .update({
      status: 'approved',
      reviewed_by: req.user?.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Create clock session if times available
  if (request.requested_clock_in) {
    await supabase.from('clock_sessions').insert({
      user_id: request.user_id,
      clock_in: request.requested_clock_in,
      clock_out: request.requested_clock_out || null,
      notes: 'Approved punch request',
    });
  }

  // Notify employee
  await supabase.from('notifications').insert({
    user_id: request.user_id,
    type: 'punch_approved',
    title: 'Punch Request Approved',
    message: `Your punch request has been approved.`,
  });

  // Activity log
  await supabase.from('activity_logs').insert({
    action: 'punch_request_approved',
    user_id: req.user?.id,
    record_id: req.params.id,
  });

  res.json({ success: true, session_created: !!request.requested_clock_in });
});

// PUT /punch-requests/:id/reject (super_admin only)
router.put('/punch-requests/:id/reject', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const rejectSchema = z.object({
    rejection_reason: z.string().min(5, 'Please provide a reason'),
  });

  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  // Get the request
  const { data: request } = await supabase
    .from('missed_punch_requests')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });

  const { data, error } = await supabase
    .from('missed_punch_requests')
    .update({
      status: 'rejected',
      reviewed_by: req.user?.id,
      reviewed_at: new Date().toISOString(),
      rejection_reason: parsed.data.rejection_reason,
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Notify employee
  await supabase.from('notifications').insert({
    user_id: request.user_id,
    type: 'punch_rejected',
    title: 'Punch Request Rejected',
    message: `Your punch request was rejected. Reason: ${parsed.data.rejection_reason}`,
  });

  // Activity log
  await supabase.from('activity_logs').insert({
    action: 'punch_request_rejected',
    user_id: req.user?.id,
    record_id: req.params.id,
    details: { rejection_reason: parsed.data.rejection_reason },
  });

  res.json({ success: true });
});

export function registerClockRoutes(api: express.Router) {
  api.use('/clock', router);
}
