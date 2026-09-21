import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { normalizeAppRole } from '../lib/roles.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);

function countOrZero(result: { count?: number | null; error?: { message?: string } | null }) {
  if (result.error) return 0;
  return result.count || 0;
}

// GET /stats — dashboard statistics
router.get('/stats', async (req, res) => {
  const userId = req.user?.id;

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isSuperAdmin = normalizeAppRole(req.user?.role) === 'super_admin';
    const today = new Date().toISOString().split('T')[0];
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    let tasksListQuery = supabase
      .from('tasks')
      .select('id, task_title, due_date, status, assigned_person_id')
      .in('status', ['pending', 'in_progress', 'Pending', 'In Progress', 'On Hold'])
      .is('deleted_at', null)
      .order('due_date', { ascending: true })
      .limit(12);
    if (!isSuperAdmin) {
      const { data: extra } = await supabase.from('task_assignees').select('task_id').eq('user_id', userId);
      const extraIds = (extra || []).map((r: { task_id: string }) => r.task_id);
      const parts = [`assigned_person_id.eq.${userId}`];
      if (extraIds.length) parts.push(`id.in.(${extraIds.join(',')})`);
      tasksListQuery = tasksListQuery.or(parts.join(','));
    }

    let projectsListQuery = supabase
      .from('projects')
      .select('id, project_name, estimated_end_date, status')
      .neq('status', 'Closed')
      .is('deleted_at', null)
      .order('estimated_end_date', { ascending: true })
      .limit(12);
    if (!isSuperAdmin) projectsListQuery = projectsListQuery.eq('assigned_person_id', userId);

    const [
      projectsRes,
      buyersRes,
      vendorsRes,
      certificationsRes,
      membershipsRes,
      partnershipsRes,
      insuranceRes,
      documentsRes,
      alertsRes,
      quotationsRes,
      invoicesRes,
      paymentsRes,
      tasksCountRes,
      todaySessionsRes,
      pipelineRes,
      recentActivityRes,
      upcomingEventsRes,
      myTasksRes,
      myProjectsRes,
      leaveTodayRes,
    ] = await Promise.all([
      supabase.from('projects').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('buyers').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('vendors').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('certifications').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('memberships').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('partnerships').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('insurance').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('documents').select('id', { count: 'exact', head: true }),
      supabase.from('alerts').select('id', { count: 'exact', head: true }).eq('is_dismissed', false),
      supabase
        .from('quotations')
        .select('id', { count: 'exact', head: true })
        .not('status', 'in', '("approved","rejected","cancelled")'),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('payments').select('id', { count: 'exact', head: true }),
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .not('status', 'in', '("completed","cancelled","Completed","Cancelled")'),
      supabase
        .from('clock_sessions')
        .select('clock_in, clock_out')
        .eq('user_id', userId)
        .gte('clock_in', today),
      supabase
        .from('buyers')
        .select('pipeline_stage_id, pipeline_stages(name, color, order_index)')
        .is('deleted_at', null),
      supabase
        .from('activity_logs')
        .select('id, action, created_at, table_name, user_id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(12),
      supabase
        .from('calendar_events')
        .select('id, title, date, event_type, start_time')
        .gte('date', today)
        .lte('date', nextWeekStr)
        .order('date', { ascending: true })
        .limit(10),
      tasksListQuery,
      projectsListQuery,
      supabase
        .from('leave_requests')
        .select('id, requested_by, start_date, end_date, status')
        .eq('status', 'approved')
        .lte('start_date', today)
        .gte('end_date', today),
    ]);

    // ---- CRM overview data (leads / contacts / companies / opportunities) ----
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const lastMonthStart = new Date(monthStart);
    lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);

    const countSince = (table: string, from: Date, to?: Date, softDelete = false) => {
      let q = supabase.from(table).select('id', { count: 'exact', head: true }).gte('created_at', from.toISOString());
      if (to) q = q.lt('created_at', to.toISOString());
      if (softDelete) q = q.is('deleted_at', null);
      return q;
    };

    let followUpsQuery = supabase.from('follow_ups').select('id, due_at, status, completed_at, assigned_to, created_by, watchers');
    if (!isSuperAdmin) {
      followUpsQuery = followUpsQuery.or(`assigned_to.eq.${userId},created_by.eq.${userId},watchers.cs.{${userId}}`);
    }

    const [
      enquiriesCountRes,
      contactsCountRes,
      companiesCountRes,
      opportunitiesCountRes,
      enquiriesThisMonthRes,
      enquiriesLastMonthRes,
      contactsThisMonthRes,
      contactsLastMonthRes,
      companiesThisMonthRes,
      companiesLastMonthRes,
      oppsThisMonthRes,
      oppsLastMonthRes,
      enquiriesAllRes,
      recentEnquiriesRes,
      followUpsRes,
    ] = await Promise.all([
      supabase.from('enquiries').select('id', { count: 'exact', head: true }),
      supabase.from('contacts').select('id', { count: 'exact', head: true }),
      supabase.from('companies').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('opportunities').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      countSince('enquiries', monthStart),
      countSince('enquiries', lastMonthStart, monthStart),
      countSince('contacts', monthStart),
      countSince('contacts', lastMonthStart, monthStart),
      countSince('companies', monthStart, undefined, true),
      countSince('companies', lastMonthStart, monthStart, true),
      countSince('opportunities', monthStart, undefined, true),
      countSince('opportunities', lastMonthStart, monthStart, true),
      supabase.from('enquiries').select('stage, priority'),
      supabase
        .from('enquiries')
        .select('id, enquiry_number, title, requirement, stage, priority, prospect_name, client_email, created_at')
        .order('created_at', { ascending: false })
        .limit(6),
      followUpsQuery,
    ]);

    const pctChange = (thisM: number, lastM: number) =>
      lastM === 0 ? (thisM > 0 ? 100 : 0) : Math.round(((thisM - lastM) / lastM) * 100);

    const enquiriesByStage: Record<string, number> = {};
    const enquiriesByPriority: Record<string, number> = {};
    for (const e of (enquiriesAllRes.error ? [] : enquiriesAllRes.data) || []) {
      const st = e.stage || 'new_enquiry';
      enquiriesByStage[st] = (enquiriesByStage[st] || 0) + 1;
      const pr = (e.priority || 'medium').toLowerCase();
      enquiriesByPriority[pr] = (enquiriesByPriority[pr] || 0) + 1;
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const startOfTodayFu = new Date();
    startOfTodayFu.setHours(0, 0, 0, 0);
    const endOfTodayMs = startOfTodayFu.getTime() + DAY_MS;
    const soonEndMs = startOfTodayFu.getTime() + 4 * DAY_MS;
    const followUps = { overdue: 0, due_today: 0, due_soon: 0, upcoming: 0, completed_this_month: 0 };
    for (const f of (followUpsRes.error ? [] : followUpsRes.data) || []) {
      if (f.status === 'completed') {
        if (f.completed_at && new Date(f.completed_at).getTime() >= monthStart.getTime()) followUps.completed_this_month++;
        continue;
      }
      if (f.status !== 'pending') continue;
      const due = new Date(f.due_at).getTime();
      if (due < nowMs) followUps.overdue++;
      else if (due < endOfTodayMs) followUps.due_today++;
      else if (due < soonEndMs) followUps.due_soon++;
      else followUps.upcoming++;
    }

    const crm = {
      enquiries: { total: countOrZero(enquiriesCountRes), change: pctChange(countOrZero(enquiriesThisMonthRes), countOrZero(enquiriesLastMonthRes)) },
      contacts: { total: countOrZero(contactsCountRes), change: pctChange(countOrZero(contactsThisMonthRes), countOrZero(contactsLastMonthRes)) },
      companies: { total: countOrZero(companiesCountRes), change: pctChange(countOrZero(companiesThisMonthRes), countOrZero(companiesLastMonthRes)) },
      opportunities: { total: countOrZero(opportunitiesCountRes), change: pctChange(countOrZero(oppsThisMonthRes), countOrZero(oppsLastMonthRes)) },
      enquiriesByStage,
      enquiriesByPriority,
      recentEnquiries: recentEnquiriesRes.error ? [] : recentEnquiriesRes.data || [],
      followUps,
    };

    const todaySessions = todaySessionsRes.data;
    const pipelineData = pipelineRes.data;
    const recentActivity = recentActivityRes.data;
    const upcomingEvents = upcomingEventsRes.data;
    const myTasksRaw = myTasksRes.data;
    const myProjectsRaw = myProjectsRes.data;
    const leaveTodayRaw = leaveTodayRes.error ? [] : leaveTodayRes.data || [];

    let hoursToday = 0;
    if (todaySessions) {
      for (const session of todaySessions) {
        const clockIn = new Date(session.clock_in);
        const clockOut = session.clock_out ? new Date(session.clock_out) : new Date();
        hoursToday += (clockOut.getTime() - clockIn.getTime()) / (1000 * 60 * 60);
      }
    }

    const pipelineOverview: Record<string, { count: number; color: string; name: string }> = {};
    if (pipelineData) {
      for (const buyer of pipelineData) {
        const stages = buyer.pipeline_stages as any[];
        if (stages && stages.length > 0) {
          const stage = stages[0];
          const key = stage.name;
          if (!pipelineOverview[key]) {
            pipelineOverview[key] = { count: 0, color: stage.color, name: stage.name };
          }
          pipelineOverview[key].count++;
        }
      }
    }

    const assigneeIds = Array.from(
      new Set(
        [
          ...(myTasksRaw || []).map((t: { assigned_person_id?: string }) => t.assigned_person_id),
          ...leaveTodayRaw.map((r: { requested_by?: string }) => r.requested_by),
        ].filter(Boolean),
      ),
    ) as string[];
    let namesById: Record<string, string> = {};
    if (assigneeIds.length) {
      const { data: users } = await supabase.from('users').select('id, full_name, email').in('id', assigneeIds);
      namesById = (users || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
        acc[u.id] = u.full_name || u.email || 'Employee';
        return acc;
      }, {});
    }

    const myTasks = (myTasksRaw || []).map((t: any) => ({
      id: t.id,
      title: t.task_title,
      due_date: t.due_date,
      status: t.status,
      assignee_name: t.assigned_person_id ? namesById[t.assigned_person_id] || null : null,
    }));

    const myProjects = (myProjectsRaw || []).map((p: any) => ({
      id: p.id,
      name: p.project_name,
      end_date: p.estimated_end_date,
      status: p.status,
    }));

    const onLeaveToday = leaveTodayRaw.map((r: any) => ({
      id: r.id,
      name: r.requested_by ? namesById[r.requested_by] || 'Employee' : 'Employee',
      start_date: r.start_date,
      end_date: r.end_date,
    }));

    res.json({
      stats: {
        projects: countOrZero(projectsRes),
        buyers: countOrZero(buyersRes),
        vendors: countOrZero(vendorsRes),
        certifications: countOrZero(certificationsRes),
        memberships: countOrZero(membershipsRes),
        partnerships: countOrZero(partnershipsRes),
        insurance: countOrZero(insuranceRes),
        documents: countOrZero(documentsRes),
        quotations: countOrZero(quotationsRes),
        invoices: countOrZero(invoicesRes),
        payments: countOrZero(paymentsRes),
        tasks: countOrZero(tasksCountRes),
        alerts: countOrZero(alertsRes),
        hoursToday: Math.round(hoursToday * 100) / 100,
      },
      crm,
      pipelineOverview,
      recentActivity: recentActivity || [],
      upcomingEvents: upcomingEvents || [],
      myTasks,
      myProjects,
      onLeaveToday,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export function registerDashboardRoutes(api: express.Router) {
  api.use('/dashboard', router);
}
