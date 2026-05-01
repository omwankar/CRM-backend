import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

// Validation schemas
const createProjectSchema = z.object({
  project_name: z.string().min(1, 'Project name is required'),
  contact_person: z.string().min(1, 'Contact person is required'),
  contact_email: z.string().email().optional().or(z.literal('')),
  contact_phone: z.string().optional(),
  start_date: z.string().optional(),
  estimated_end_date: z.string().optional(),
  requirements_notes: z.string().optional(),
  linked_email: z.string().email().optional().or(z.literal('')),
  status: z.enum(['Active', 'Planned', 'On Hold', 'Closed']).default('Planned'),
  created_by: z.string().uuid(),
});

const updateProjectSchema = z.object({
  project_name: z.string().min(1).optional(),
  contact_person: z.string().min(1).optional(),
  contact_email: z.string().email().optional().or(z.literal('')),
  contact_phone: z.string().optional(),
  start_date: z.string().optional(),
  estimated_end_date: z.string().optional(),
  requirements_notes: z.string().optional(),
  linked_email: z.string().email().optional().or(z.literal('')),
  status: z.enum(['Active', 'Planned', 'On Hold', 'Closed']).optional(),
});

const changeStatusSchema = z.object({
  status: z.enum(['Active', 'Planned', 'On Hold', 'Closed']),
  reason: z.string().min(1, 'Reason is required'),
  changed_by: z.string().uuid(),
});

const addEmployeeSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['admin', 'assigned', 'operations', 'sales']),
});

// GET /api/projects - List all projects with filters
router.get('/', async (req, res) => {
  try {
    const { status, search, start_date, end_date, page = '1', limit = '20' } = req.query;
    
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('projects')
      .select('*', { count: 'exact' })
      .is('deleted_at', null);

    // Apply filters
    if (status) {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(`project_name.ilike.%${search}%,contact_person.ilike.%${search}%,project_id.ilike.%${search}%`);
    }

    if (start_date) {
      query = query.gte('start_date', start_date);
    }

    if (end_date) {
      query = query.lte('estimated_end_date', end_date);
    }

    // Apply pagination
    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({
      projects: data || [],
      total: count || 0,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil((count || 0) / limitNum),
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:id - Get single project with relations
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get employees with user details
    const { data: employees } = await supabase
      .from('project_employees')
      .select(`
        id,
        user_id,
        role,
        added_at,
        users (
          id,
          email,
          full_name
        )
      `)
      .eq('project_id', id);

    // Get attachments
    const { data: attachments } = await supabase
      .from('project_attachments')
      .select('*')
      .eq('project_id', id)
      .order('uploaded_at', { ascending: false });

    // Get emails
    const { data: emails } = await supabase
      .from('project_emails')
      .select('*')
      .eq('project_id', id)
      .order('received_at', { ascending: false });

    // Format employees with avatar initials
    const formattedEmployees = (employees || []).map((emp: any) => ({
      id: emp.id,
      user_id: emp.user_id,
      name: emp.users?.full_name || emp.users?.email || 'Unknown',
      email: emp.users?.email || '',
      role: emp.role,
      avatar_initials: (emp.users?.full_name || emp.users?.email || 'U')
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2),
      added_at: emp.added_at,
    }));

    res.json({
      ...project,
      employees: formattedEmployees,
      attachments: attachments || [],
      emails: emails || [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects - Create new project
router.post('/', async (req, res) => {
  try {
    const body = createProjectSchema.parse(req.body);

    const { data, error } = await supabase
      .from('projects')
      .insert(body)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Add creator as admin employee
    await supabase
      .from('project_employees')
      .insert({
        project_id: data.id,
        user_id: body.created_by,
        role: 'admin',
      });

    // Add initial status history
    await supabase
      .from('project_status_history')
      .insert({
        project_id: data.id,
        old_status: null,
        new_status: body.status,
        reason: 'Project created',
        changed_by: body.created_by,
      });

    res.status(201).json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:id - Update project
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = updateProjectSchema.parse(req.body);

    const { data, error } = await supabase
      .from('projects')
      .update(body)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:id - Soft delete project
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('projects')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:id/status - Change status
router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const body = changeStatusSchema.parse(req.body);

    // Get current status
    const { data: currentProject } = await supabase
      .from('projects')
      .select('status')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (!currentProject) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update status
    const { data, error } = await supabase
      .from('projects')
      .update({ status: body.status })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Add to status history
    await supabase
      .from('project_status_history')
      .insert({
        project_id: id,
        old_status: currentProject.status,
        new_status: body.status,
        reason: body.reason,
        changed_by: body.changed_by,
      });

    res.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:id/history - Get status change history
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('project_status_history')
      .select(`
        id,
        old_status,
        new_status,
        reason,
        changed_by,
        changed_at,
        users (
          full_name,
          email
        )
      `)
      .eq('project_id', id)
      .order('changed_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const formattedHistory = (data || []).map((h: any) => ({
      id: h.id,
      old_status: h.old_status,
      new_status: h.new_status,
      reason: h.reason,
      changed_by_name: h.users?.full_name || h.users?.email || 'Unknown',
      changed_at: h.changed_at,
    }));

    res.json(formattedHistory);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:id/employees - Add employee
router.post('/:id/employees', async (req, res) => {
  try {
    const { id } = req.params;
    const body = addEmployeeSchema.parse(req.body);

    const { data, error } = await supabase
      .from('project_employees')
      .insert({
        project_id: id,
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

// DELETE /api/projects/:id/employees/:uid - Remove employee
router.delete('/:id/employees/:uid', async (req, res) => {
  try {
    const { id, uid } = req.params;

    const { error } = await supabase
      .from('project_employees')
      .delete()
      .eq('project_id', id)
      .eq('user_id', uid);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Employee removed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:id/attachments - Upload attachment
router.post('/:id/attachments', async (req, res) => {
  try {
    const { id } = req.params;
    const { file_name, file_type, file_url, file_size, uploaded_by } = req.body;

    const { data, error } = await supabase
      .from('project_attachments')
      .insert({
        project_id: id,
        file_name,
        file_type,
        file_url,
        file_size,
        uploaded_by,
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

// DELETE /api/projects/:id/attachments/:aid - Delete attachment
router.delete('/:id/attachments/:aid', async (req, res) => {
  try {
    const { id, aid } = req.params;

    const { error } = await supabase
      .from('project_attachments')
      .delete()
      .eq('id', aid)
      .eq('project_id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Attachment deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:id/emails - Get linked emails
router.get('/:id/emails', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('project_emails')
      .select('*')
      .eq('project_id', id)
      .order('received_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:id/emails/:eid/read - Mark email as read
router.post('/:id/emails/:eid/read', async (req, res) => {
  try {
    const { id, eid } = req.params;

    const { data, error } = await supabase
      .from('project_emails')
      .update({ is_read: true })
      .eq('id', eid)
      .eq('project_id', id)
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

export function registerProjectRoutes(api: express.Router) {
  api.use('/projects', router);
}
