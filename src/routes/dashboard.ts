import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);

// GET /stats — dashboard statistics
router.get('/stats', async (req, res) => {
  const userId = req.user?.id;
  const userRole = req.user?.role;

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get counts for all modules
    const [
      { count: projectsCount },
      { count: buyersCount },
      { count: vendorsCount },
      { count: certificationsCount },
      { count: membershipsCount },
      { count: partnershipsCount },
      { count: insuranceCount },
      { count: documentsCount },
      { count: alertsCount },
      { count: quotationsCount },
    ] = await Promise.all([
      supabase.from('projects').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('buyers').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('vendors').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('certifications').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('memberships').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('partnerships').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('insurance').select('*', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('documents').select('*', { count: 'exact', head: true }),
      supabase.from('alerts').select('*', { count: 'exact', head: true }).eq('is_dismissed', false),
      supabase
        .from('quotations')
        .select('*', { count: 'exact', head: true })
        .not('status', 'in', '("approved","rejected","cancelled")'),
    ]);

    // Get today's clocked hours
    const today = new Date().toISOString().split('T')[0];
    const { data: todaySessions } = await supabase
      .from('clock_sessions')
      .select('clock_in, clock_out')
      .eq('user_id', userId)
      .gte('clock_in', today);

    let hoursToday = 0;
    if (todaySessions) {
      for (const session of todaySessions) {
        const clockIn = new Date(session.clock_in);
        const clockOut = session.clock_out ? new Date(session.clock_out) : new Date();
        hoursToday += (clockOut.getTime() - clockIn.getTime()) / (1000 * 60 * 60);
      }
    }

    // Get pipeline overview for buyers
    const { data: pipelineData } = await supabase
      .from('buyers')
      .select('pipeline_stage_id, pipeline_stages(name, color, order_index)')
      .is('deleted_at', null);

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

    // Get recent activity (last 10)
    const { data: recentActivity } = await supabase
      .from('activity_logs')
      .select('*, users(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(10);

    // Get upcoming calendar events (next 7 days)
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const { data: upcomingEvents } = await supabase
      .from('calendar_events')
      .select('*')
      .gte('date', today)
      .lte('date', nextWeek.toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(10);

    // Get user's tasks (assigned_person_id in current schema)
    const { data: myTasksRaw } = await supabase
      .from('tasks')
      .select('id, task_title, due_date, status')
      .eq('assigned_person_id', userId)
      .in('status', ['Pending', 'In Progress', 'On Hold'])
      .is('deleted_at', null)
      .order('due_date', { ascending: true })
      .limit(10);

    const myTasks = (myTasksRaw || []).map((t: any) => ({
      id: t.id,
      title: t.task_title,
      due_date: t.due_date,
      status: t.status,
    }));

    // Get user's projects (assigned_person_id)
    const { data: myProjectsRaw } = await supabase
      .from('projects')
      .select('id, project_name, estimated_end_date, status')
      .eq('assigned_person_id', userId)
      .neq('status', 'Closed')
      .is('deleted_at', null)
      .order('estimated_end_date', { ascending: true })
      .limit(10);

    const myProjects = (myProjectsRaw || []).map((p: any) => ({
      id: p.id,
      name: p.project_name,
      end_date: p.estimated_end_date,
      status: p.status,
    }));

    res.json({
      stats: {
        projects: projectsCount || 0,
        buyers: buyersCount || 0,
        vendors: vendorsCount || 0,
        certifications: certificationsCount || 0,
        memberships: membershipsCount || 0,
        partnerships: partnershipsCount || 0,
        insurance: insuranceCount || 0,
        documents: documentsCount || 0,
        quotations: quotationsCount || 0,
        alerts: alertsCount || 0,
        hoursToday: Math.round(hoursToday * 100) / 100,
      },
      pipelineOverview,
      recentActivity,
      upcomingEvents,
      myTasks,
      myProjects,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export function registerDashboardRoutes(api: express.Router) {
  api.use('/dashboard', router);
}
