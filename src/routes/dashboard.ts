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
    if (!isSuperAdmin) tasksListQuery = tasksListQuery.eq('assigned_person_id', userId);

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
