import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { taskWriteGuard } from '../middleware/requireRole.js';

const router = express.Router();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

router.use(authMiddleware);
// Tasks are read-public, write-restricted: managers/super_admin always; a
// plain `user` may modify only tasks they are assigned to / supervise / created.
router.use(taskWriteGuard);

// Validation schemas
const createTaskSchema = z.object({
  task_title: z.string().min(1, 'Task title is required'),
  task_type: z.enum(['admin', 'sales']),
  project_id: z.string().uuid().nullable().optional(),
  assigned_person_id: z.string().uuid().nullable().optional(),
  supervisor_id: z.string().uuid().nullable().optional(),
  assigned_date: z.string().optional(),
  due_date: z.string().optional(),
  status: z.enum(['Pending', 'In Progress', 'On Hold', 'Completed', 'Cancelled']).default('Pending'),
  notes: z.string().optional(),
  linked_email: z.string().email().optional().or(z.literal('')),
  created_by: z.string().uuid(),
}).refine(
  (data) => data.task_type !== 'sales' || data.project_id,
  { message: 'Project is required for sales tasks', path: ['project_id'] }
);

const updateTaskSchema = z.object({
  task_title: z.string().min(1).optional(),
  task_type: z.enum(['admin', 'sales']).optional(),
  project_id: z.string().uuid().nullable().optional(),
  assigned_person_id: z.string().uuid().nullable().optional(),
  supervisor_id: z.string().uuid().nullable().optional(),
  assigned_date: z.string().optional(),
  due_date: z.string().optional(),
  status: z.enum(['Pending', 'In Progress', 'On Hold', 'Completed', 'Cancelled']).optional(),
  notes: z.string().optional(),
  linked_email: z.string().email().optional().or(z.literal('')),
}).refine(
  (data) => {
    if (data.task_type === 'sales' && data.project_id === null) return false;
    return true;
  },
  { message: 'Project is required for sales tasks', path: ['project_id'] }
);

const changeStatusSchema = z.object({
  status: z.enum(['Pending', 'In Progress', 'On Hold', 'Completed', 'Cancelled']),
  reason: z.string().min(1, 'Reason is required'),
  changed_by: z.string().uuid().optional(),
});

const addEmployeeSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['admin', 'assigned', 'viewer']),
});

// GET /api/tasks - List all tasks with filters
router.get('/', async (req, res) => {
  try {
    const { status, task_type, search, project_id, start_date, end_date, sort_by, sort_order, page = '1', limit = '20' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('tasks')
      .select('*', { count: 'exact' })
      .is('deleted_at', null);

    // Apply filters
    if (status) {
      query = query.eq('status', status);
    }

    if (task_type) {
      query = query.eq('task_type', task_type);
    }

    if (project_id) {
      query = query.eq('project_id', project_id);
    }

    if (search) {
      query = query.or(`task_title.ilike.%${search}%,task_id.ilike.%${search}%`);
    }

    if (start_date) {
      query = query.gte('assigned_date', start_date);
    }

    if (end_date) {
      query = query.lte('due_date', end_date);
    }

    // Apply sorting
    const allowedSortColumns = new Set(['created_at', 'due_date', 'assigned_date', 'task_title']);
    const requestedSortBy = (sort_by as string) || 'created_at';
    const sortBy = allowedSortColumns.has(requestedSortBy) ? requestedSortBy : 'created_at';
    const sortOrder = sort_order as string || 'desc';
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });

    // Apply pagination
    query = query.range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const tasks = data || [];

    // Enrich with person and project info
    const personIds = new Set<string>();
    const projectIds = new Set<string>();
    tasks.forEach((task: any) => {
      if (task.assigned_person_id) personIds.add(task.assigned_person_id);
      if (task.supervisor_id) personIds.add(task.supervisor_id);
      if (task.project_id) projectIds.add(task.project_id);
    });

    let usersById: Record<string, any> = {};
    if (personIds.size > 0) {
      const { data: usersData } = await supabase
        .from('users')
        .select('id, email, full_name')
        .in('id', Array.from(personIds));

      usersById = (usersData || []).reduce((acc: Record<string, any>, user: any) => {
        acc[user.id] = user;
        return acc;
      }, {});
    }

    let projectsById: Record<string, any> = {};
    if (projectIds.size > 0) {
      const { data: projectsData } = await supabase
        .from('projects')
        .select('id, project_id, project_name')
        .in('id', Array.from(projectIds));

      projectsById = (projectsData || []).reduce((acc: Record<string, any>, p: any) => {
        acc[p.id] = p;
        return acc;
      }, {});
    }

    const enrichedTasks = tasks.map((task: any) => {
      const assigned = task.assigned_person_id ? usersById[task.assigned_person_id] : null;
      const supervisor = task.supervisor_id ? usersById[task.supervisor_id] : null;
      const project = task.project_id ? projectsById[task.project_id] : null;

      return {
        ...task,
        assigned_person: assigned
          ? { id: assigned.id, name: assigned.full_name || assigned.email || 'Unknown', email: assigned.email || '' }
          : null,
        supervisor: supervisor
          ? { id: supervisor.id, name: supervisor.full_name || supervisor.email || 'Unknown', email: supervisor.email || '' }
          : null,
        project: project
          ? { id: project.id, project_id: project.project_id, project_name: project.project_name }
          : null,
      };
    });

    res.json({
      tasks: enrichedTasks,
      total: count || 0,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil((count || 0) / limitNum),
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tasks/:id - Get single task with relations
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (taskError || !task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Fetch assigned person details
    let assignedPerson = null;
    if (task.assigned_person_id) {
      const { data: apUser } = await supabase
        .from('users')
        .select('id, email, full_name')
        .eq('id', task.assigned_person_id)
        .maybeSingle();
      if (apUser) {
        assignedPerson = { id: apUser.id, name: apUser.full_name || apUser.email || 'Unknown', email: apUser.email || '' };
      }
    }

    // Fetch supervisor details
    let supervisor = null;
    if (task.supervisor_id) {
      const { data: supUser } = await supabase
        .from('users')
        .select('id, email, full_name')
        .eq('id', task.supervisor_id)
        .maybeSingle();
      if (supUser) {
        supervisor = { id: supUser.id, name: supUser.full_name || supUser.email || 'Unknown', email: supUser.email || '' };
      }
    }

    // Fetch project info
    let project = null;
    if (task.project_id) {
      const { data: proj } = await supabase
        .from('projects')
        .select('id, project_id, project_name')
        .eq('id', task.project_id)
        .maybeSingle();
      if (proj) {
        project = { id: proj.id, project_id: proj.project_id, project_name: proj.project_name };
      }
    }

    // Get attachments
    const { data: attachments } = await supabase
      .from('task_attachments')
      .select('*')
      .eq('task_id', id)
      .order('created_at', { ascending: false });

    // Get emails
    const { data: emails } = await supabase
      .from('task_emails')
      .select('*')
      .eq('task_id', id)
      .order('received_at', { ascending: false });

    // Get employees
    const { data: employees } = await supabase
      .from('task_employees')
      .select('id, user_id, role, added_at')
      .eq('task_id', id);

    // Fetch employee user details
    const employeeUserIds = Array.from(new Set((employees || []).map((e: any) => e.user_id).filter(Boolean)));
    let employeeUsersById: Record<string, { id: string; email?: string | null; full_name?: string | null }> = {};
    if (employeeUserIds.length > 0) {
      const { data: usersData } = await supabase
        .from('users')
        .select('id, email, full_name')
        .in('id', employeeUserIds);
      employeeUsersById = (usersData || []).reduce((acc: Record<string, any>, user: any) => {
        acc[user.id] = user;
        return acc;
      }, {});
    }

    // Format employees with avatar initials
    const formattedEmployees = (employees || []).map((emp: any) => {
      const profile = employeeUsersById[emp.user_id];
      const displayName = profile?.full_name || profile?.email || 'Unknown';
      const initials = displayName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
      return {
        id: emp.id,
        user_id: emp.user_id,
        name: displayName,
        email: profile?.email || '',
        role: emp.role,
        avatar_initials: initials,
        added_at: emp.added_at,
      };
    });

    res.json({
      ...task,
      assigned_person: assignedPerson,
      supervisor: supervisor,
      project: project,
      employees: formattedEmployees,
      attachments: attachments || [],
      emails: emails || [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks - Create new task
router.post('/', async (req, res) => {
  try {
    const body = createTaskSchema.parse(req.body);

    // Generate task_id
    const { data: lastTask } = await supabase
      .from('tasks')
      .select('task_id')
      .order('task_id', { ascending: false })
      .limit(1)
      .maybeSingle();

    let nextNum = 1;
    if (lastTask?.task_id) {
      const numPart = lastTask.task_id.replace('TASK-', '');
      nextNum = parseInt(numPart) + 1;
    }
    const taskId = `TASK-${String(nextNum).padStart(4, '0')}`;

    const { data, error } = await supabase
      .from('tasks')
      .insert({ ...body, task_id: taskId })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Add initial status history
    await supabase
      .from('task_status_history')
      .insert({
        task_id: data.id,
        old_status: null,
        new_status: body.status,
        reason: 'Task created',
        changed_by: body.created_by,
      });

    // Add creator as admin employee
    await supabase
      .from('task_employees')
      .insert({
        task_id: data.id,
        user_id: body.created_by,
        role: 'admin',
      });

    res.status(201).json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/tasks/:id - Update task
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = updateTaskSchema.parse(req.body);

    const { data, error } = await supabase
      .from('tasks')
      .update(body)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:id - Soft delete
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:id/status - Change status
router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const body = changeStatusSchema.parse(req.body);
    const actorId = body.changed_by || req.user?.id;
    if (!actorId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get current status
    const { data: currentTask } = await supabase
      .from('tasks')
      .select('status')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (!currentTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Update status
    const { data, error } = await supabase
      .from('tasks')
      .update({ status: body.status })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Add to status history
    await supabase
      .from('task_status_history')
      .insert({
        task_id: id,
        old_status: currentTask.status,
        new_status: body.status,
        reason: body.reason,
        changed_by: actorId,
      });

    res.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tasks/:id/history - Get status change history
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('task_status_history')
      .select('id, old_status, new_status, reason, changed_by, changed_at')
      .eq('task_id', id)
      .order('changed_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const changedByIds = Array.from(
      new Set((data || []).map((h: any) => h.changed_by).filter(Boolean))
    );

    let usersById: Record<string, { full_name?: string | null; email?: string | null }> = {};
    if (changedByIds.length > 0) {
      const { data: usersData } = await supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', changedByIds);

      usersById = (usersData || []).reduce((acc: Record<string, any>, user: any) => {
        acc[user.id] = user;
        return acc;
      }, {});
    }

    const formattedHistory = (data || []).map((h: any) => ({
      id: h.id,
      old_status: h.old_status,
      new_status: h.new_status,
      reason: h.reason,
      changed_by_name:
        usersById[h.changed_by]?.full_name ||
        usersById[h.changed_by]?.email ||
        'Unknown',
      changed_at: h.changed_at,
    }));

    res.json(formattedHistory);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:id/employees - Add employee
router.post('/:id/employees', async (req, res) => {
  try {
    const { id } = req.params;
    const body = addEmployeeSchema.parse(req.body);

    const { data, error } = await supabase
      .from('task_employees')
      .insert({
        task_id: id,
        ...body,
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:id/employees/:uid - Remove employee
router.delete('/:id/employees/:uid', async (req, res) => {
  try {
    const { id, uid } = req.params;

    const { error } = await supabase
      .from('task_employees')
      .delete()
      .eq('task_id', id)
      .eq('user_id', uid);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Employee removed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:id/attachments - Upload attachment
router.post('/:id/attachments', async (req, res) => {
  try {
    const { id } = req.params;
    const body = z.object({
      file_name: z.string(),
      file_type: z.string(),
      file_url: z.string(),
      file_size: z.number(),
      uploaded_by: z.string().uuid(),
    }).parse(req.body);

    const { data, error } = await supabase
      .from('task_attachments')
      .insert({
        task_id: id,
        ...body,
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:id/attachments/:aid - Delete attachment
router.delete('/:id/attachments/:aid', async (req, res) => {
  try {
    const { id, aid } = req.params;

    const { error } = await supabase
      .from('task_attachments')
      .delete()
      .eq('id', aid)
      .eq('task_id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Attachment deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tasks/:id/emails - Get linked emails
router.get('/:id/emails', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('task_emails')
      .select('*')
      .eq('task_id', id)
      .order('received_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:id/emails/:eid/read - Mark email as read
router.post('/:id/emails/:eid/read', async (req, res) => {
  try {
    const { id, eid } = req.params;

    const { data, error } = await supabase
      .from('task_emails')
      .update({ is_read: true })
      .eq('id', eid)
      .eq('task_id', id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export function registerTaskRoutes(api: express.Router) {
  api.use('/tasks', router);
}
