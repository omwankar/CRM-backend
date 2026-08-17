import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

export const TASK_ENTITY_TYPES = [
  'lead',
  'opportunity',
  'enquiry',
  'quotation',
  'buyer',
  'vendor',
  'job',
  'project',
  'invoice',
  'contact',
  'company',
] as const;

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;

const SALES_TYPES = ['lead', 'opportunity', 'enquiry', 'quotation', 'buyer', 'contact', 'company'] as const;
const OPS_TYPES = ['job', 'project', 'vendor'] as const;
const FINANCE_TYPES = ['invoice'] as const;

const createSchema = z.object({
  title: z.string().trim().min(1).optional(),
  task_title: z.string().trim().min(1).optional(), // legacy alias
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(), // legacy alias for description
  entity_type: z.enum(TASK_ENTITY_TYPES).optional().nullable(),
  entity_id: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(), // legacy → project entity
  assignee_id: z.string().uuid().optional(),
  assigned_person_id: z.string().uuid().optional(), // legacy alias
  supervisor_id: z.string().uuid().optional().nullable(),
  due_date: z.string().min(1),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  task_type: z.enum(['admin', 'sales']).optional(), // legacy, ignored for filtering
}).refine((d) => Boolean(d.title || d.task_title), { message: 'Title is required', path: ['title'] })
  .refine((d) => Boolean(d.assignee_id || d.assigned_person_id), {
    message: 'Assignee is required',
    path: ['assignee_id'],
  })
  .refine(
    (d) => {
      const et = d.entity_type ?? (d.project_id ? 'project' : null);
      const eid = d.entity_id ?? d.project_id ?? null;
      if (et && !eid) return false;
      if (!et && eid) return false;
      return true;
    },
    { message: 'entity_type and entity_id must be set together', path: ['entity_id'] },
  );

const updateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  task_title: z.string().trim().min(1).optional(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  entity_type: z.enum(TASK_ENTITY_TYPES).optional().nullable(),
  entity_id: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  assignee_id: z.string().uuid().optional(),
  assigned_person_id: z.string().uuid().optional(),
  supervisor_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
});

const completeSchema = z.object({
  log_activity: z.boolean().optional(),
  activity_type: z.enum(['call', 'email', 'meeting', 'note']).optional(),
  activity_subject: z.string().optional().nullable(),
  activity_notes: z.string().optional().nullable(),
});

function isPrivileged(role?: string) {
  return role === 'manager' || role === 'super_admin';
}

function isOverdue(task: { status: string; due_date: string | null }) {
  if (task.status === 'completed' || task.status === 'cancelled' || !task.due_date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(task.due_date);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

async function notify(userId: string | null | undefined, title: string, message: string) {
  if (!userId) return;
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'task',
    title,
    message,
  });
}

async function enrichTasks(tasks: any[]) {
  if (!tasks.length) return [];

  const personIds = new Set<string>();
  const projectIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const t of tasks) {
    if (t.assigned_person_id) personIds.add(t.assigned_person_id);
    if (t.supervisor_id) personIds.add(t.supervisor_id);
    if (t.created_by) personIds.add(t.created_by);
    if (t.entity_type === 'project' && t.entity_id) projectIds.add(t.entity_id);
    else if (t.entity_type === 'job' && t.entity_id) jobIds.add(t.entity_id);
    else if (t.project_id) projectIds.add(t.project_id);
  }

  let usersById: Record<string, any> = {};
  if (personIds.size) {
    const { data } = await supabase
      .from('users')
      .select('id, email, full_name')
      .in('id', [...personIds]);
    usersById = (data || []).reduce((acc: any, u: any) => {
      acc[u.id] = u;
      return acc;
    }, {});
  }

  let projectsById: Record<string, any> = {};
  if (projectIds.size) {
    const { data } = await supabase
      .from('projects')
      .select('id, project_id, project_name')
      .in('id', [...projectIds]);
    projectsById = (data || []).reduce((acc: any, p: any) => {
      acc[p.id] = p;
      return acc;
    }, {});
  }

  let jobsById: Record<string, any> = {};
  if (jobIds.size) {
    const { data } = await supabase
      .from('jobs')
      .select('id, job_number, title')
      .in('id', [...jobIds]);
    jobsById = (data || []).reduce((acc: any, j: any) => {
      acc[j.id] = j;
      return acc;
    }, {});
  }

  return tasks.map((t) => {
    const assignee = t.assigned_person_id ? usersById[t.assigned_person_id] : null;
    const supervisor = t.supervisor_id ? usersById[t.supervisor_id] : null;
    const creator = t.created_by ? usersById[t.created_by] : null;
    const projectKey = t.entity_type === 'project' ? t.entity_id : t.project_id;
    const project = projectKey ? projectsById[projectKey] : null;
    const job = t.entity_type === 'job' && t.entity_id ? jobsById[t.entity_id] : null;
    return {
      ...t,
      title: t.task_title,
      description: t.notes,
      assignee_id: t.assigned_person_id,
      overdue: isOverdue(t),
      assignee: assignee
        ? { id: assignee.id, name: assignee.full_name || assignee.email || 'Unknown', email: assignee.email || '' }
        : null,
      supervisor: supervisor
        ? {
            id: supervisor.id,
            name: supervisor.full_name || supervisor.email || 'Unknown',
            email: supervisor.email || '',
          }
        : null,
      creator: creator
        ? { id: creator.id, name: creator.full_name || creator.email || 'Unknown', email: creator.email || '' }
        : null,
      project: project
        ? { id: project.id, project_id: project.project_id, project_name: project.project_name }
        : null,
      job: job ? { id: job.id, job_number: job.job_number, title: job.title } : null,
      entity_label: job
        ? `${job.job_number} · ${job.title}`
        : project
          ? project.project_name || project.project_id
          : null,
    };
  });
}

function canComplete(task: any, userId?: string, role?: string) {
  if (!userId) return false;
  if (isPrivileged(role)) return true;
  return task.assigned_person_id === userId || task.supervisor_id === userId;
}

function canDelete(task: any, userId?: string, role?: string) {
  if (!userId) return false;
  if (isPrivileged(role)) return true;
  return task.created_by === userId || task.supervisor_id === userId;
}

function canEdit(task: any, userId?: string, role?: string) {
  if (!userId) return false;
  if (isPrivileged(role)) return true;
  return (
    task.assigned_person_id === userId ||
    task.supervisor_id === userId ||
    task.created_by === userId
  );
}

// GET /api/tasks
router.get('/', async (req, res) => {
  const {
    view = 'mine',
    status,
    priority,
    overdue,
    search,
    entity_type,
    entity_id,
    assignee_id,
    page = '1',
    limit = '50',
  } = req.query;

  const userId = req.user?.id;
  const role = req.user?.role;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  if (view === 'team' && !isPrivileged(role)) {
    return res.status(403).json({ error: 'Team view requires manager access' });
  }

  let query = supabase.from('tasks').select('*', { count: 'exact' }).is('deleted_at', null);

  if (view === 'mine') {
    query = query.or(
      `assigned_person_id.eq.${userId},created_by.eq.${userId},supervisor_id.eq.${userId}`,
    );
  } else if (view === 'sales') {
    query = query.or(`entity_type.is.null,entity_type.in.(${SALES_TYPES.join(',')})`);
  } else if (view === 'operations') {
    query = query.or(`entity_type.is.null,entity_type.in.(${OPS_TYPES.join(',')})`);
  } else if (view === 'finance') {
    query = query.or(`entity_type.is.null,entity_type.in.(${FINANCE_TYPES.join(',')})`);
  } else if (view === 'team') {
    // all tasks
  } else if (view === 'entity') {
    if (!entity_type || !entity_id) {
      return res.status(400).json({ error: 'entity_type and entity_id required for entity view' });
    }
    query = query.eq('entity_type', String(entity_type)).eq('entity_id', String(entity_id));
  }

  if (status && status !== 'all') query = query.eq('status', String(status));
  if (priority && priority !== 'all') query = query.eq('priority', String(priority));
  if (assignee_id) query = query.eq('assigned_person_id', String(assignee_id));
  if (entity_type && view !== 'entity') query = query.eq('entity_type', String(entity_type));
  if (entity_id && view !== 'entity') query = query.eq('entity_id', String(entity_id));

  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) query = query.or(`task_title.ilike.%${s}%,notes.ilike.%${s}%,task_id.ilike.%${s}%`);
  }

  if (overdue === '1' || overdue === 'true') {
    const today = new Date().toISOString().slice(0, 10);
    query = query
      .lt('due_date', today)
      .not('status', 'in', '("completed","cancelled")');
  }

  query = query.order('due_date', { ascending: true }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const enriched = await enrichTasks(data || []);
  res.json({
    data: enriched,
    tasks: enriched, // legacy key
    total: count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

// GET /api/tasks/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Task not found' });
  const [enriched] = await enrichTasks([data]);
  res.json(enriched);
});

// POST /api/tasks
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const body = parsed.data;
  const title = (body.title || body.task_title || '').trim();
  const assignee = body.assignee_id || body.assigned_person_id!;
  let entityType = body.entity_type ?? null;
  let entityId = body.entity_id ?? null;
  if (!entityType && body.project_id) {
    entityType = 'project';
    entityId = body.project_id;
  }

  const row: Record<string, unknown> = {
    task_title: title,
    notes: body.description ?? body.notes ?? null,
    assigned_person_id: assignee,
    supervisor_id: body.supervisor_id ?? null,
    due_date: body.due_date,
    priority: body.priority || 'medium',
    status: body.status || 'pending',
    entity_type: entityType,
    entity_id: entityId,
    project_id: entityType === 'project' ? entityId : body.project_id ?? null,
    task_type: entityType && (SALES_TYPES as readonly string[]).includes(entityType) ? 'sales' : 'admin',
    assigned_date: new Date().toISOString().slice(0, 10),
    created_by: userId,
  };

  const { data, error } = await supabase.from('tasks').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (assignee !== userId) {
    await notify(assignee, 'New task assigned', `"${title}" was assigned to you.`);
  }

  const [enriched] = await enrichTasks([data]);
  res.status(201).json(enriched);
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  const { data: existing } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  if (!canEdit(existing, userId, role)) {
    return res.status(403).json({ error: 'You can only edit tasks you own, supervise, or created' });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const body = parsed.data;
  const patch: Record<string, unknown> = {};

  if (body.title || body.task_title) patch.task_title = body.title || body.task_title;
  if (body.description !== undefined || body.notes !== undefined) {
    patch.notes = body.description ?? body.notes ?? null;
  }
  if (body.assignee_id || body.assigned_person_id) {
    patch.assigned_person_id = body.assignee_id || body.assigned_person_id;
  }
  if (body.supervisor_id !== undefined) patch.supervisor_id = body.supervisor_id;
  if (body.due_date) patch.due_date = body.due_date;
  if (body.priority) patch.priority = body.priority;

  if (body.entity_type !== undefined || body.entity_id !== undefined || body.project_id !== undefined) {
    let et = body.entity_type !== undefined ? body.entity_type : existing.entity_type;
    let eid = body.entity_id !== undefined ? body.entity_id : existing.entity_id;
    if (body.project_id) {
      et = 'project';
      eid = body.project_id;
    }
    patch.entity_type = et;
    patch.entity_id = eid;
    patch.project_id = et === 'project' ? eid : null;
  }

  if (body.status) {
    if (body.status === 'completed' && existing.status !== 'completed') {
      if (!canComplete(existing, userId, role)) {
        return res.status(403).json({ error: 'Only assignee, supervisor, or manager can complete this task' });
      }
      patch.status = 'completed';
      patch.completed_at = new Date().toISOString();
    } else {
      patch.status = body.status;
      if (body.status !== 'completed') patch.completed_at = null;
    }
  }

  const prevAssignee = existing.assigned_person_id;
  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message || 'Update failed' });

  if (patch.assigned_person_id && patch.assigned_person_id !== prevAssignee) {
    await notify(
      String(patch.assigned_person_id),
      'Task assigned to you',
      `"${data.task_title}" was assigned to you.`,
    );
  }

  if (patch.status === 'completed' && existing.supervisor_id && existing.supervisor_id !== userId) {
    await notify(
      existing.supervisor_id,
      'Task completed',
      `"${data.task_title}" was marked completed.`,
    );
  }

  const [enriched] = await enrichTasks([data]);
  res.json(enriched);
});

// POST /api/tasks/:id/complete — complete + optional activity log
router.post('/:id/complete', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  const parsed = completeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const { data: existing } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  if (!canComplete(existing, userId, role)) {
    return res.status(403).json({ error: 'Only assignee, supervisor, or manager can complete this task' });
  }

  let activityId: string | null = existing.converted_to_activity_id || null;

  if (parsed.data.log_activity && existing.entity_type && existing.entity_id) {
    const activityType = parsed.data.activity_type || 'note';
    const { data: activity, error: actErr } = await supabase
      .from('activities')
      .insert({
        type: activityType,
        entity_type: existing.entity_type,
        entity_id: existing.entity_id,
        subject: parsed.data.activity_subject?.trim() || existing.task_title,
        notes: parsed.data.activity_notes?.trim() || existing.notes || null,
        activity_date: new Date().toISOString(),
        created_by: userId,
      })
      .select('id')
      .single();
    if (!actErr && activity) activityId = activity.id;
  }

  const { data, error } = await supabase
    .from('tasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      converted_to_activity_id: activityId,
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || 'Complete failed' });

  if (existing.supervisor_id && existing.supervisor_id !== userId) {
    await notify(existing.supervisor_id, 'Task completed', `"${data.task_title}" was marked completed.`);
  }

  const [enriched] = await enrichTasks([data]);
  res.json(enriched);
});

// DELETE soft
router.delete('/:id', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  const { data: existing } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  if (!canDelete(existing, userId, role)) {
    return res.status(403).json({ error: 'Only creator, supervisor, or manager can delete' });
  }

  const { error } = await supabase
    .from('tasks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerTaskRoutes(api: express.Router) {
  api.use('/tasks', router);
}

/** Daily overdue notifications — call from cron */
export async function notifyOverdueTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('tasks')
    .select('id, task_title, assigned_person_id, supervisor_id, due_date')
    .is('deleted_at', null)
    .lt('due_date', today)
    .not('status', 'in', '("completed","cancelled")');

  const formatDue = (raw: string | null | undefined) => {
    const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : raw || '';
  };

  for (const t of data || []) {
    const msg = `"${t.task_title}" is overdue (due ${formatDue(t.due_date)}).`;
    await notify(t.assigned_person_id, 'Task overdue', msg);
    if (t.supervisor_id && t.supervisor_id !== t.assigned_person_id) {
      await notify(t.supervisor_id, 'Task overdue', msg);
    }
  }
  return (data || []).length;
}
