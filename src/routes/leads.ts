import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Any authenticated user (including sales employees) can create and work leads.
router.use(authMiddleware);
router.use(auditLog);

const leadStatus = z.enum(['new', 'contacted', 'qualified', 'converted', 'lost']);

const createLeadSchema = z.object({
  lead_name: z.string().trim().min(1),
  company_name: z.string().trim().optional().nullable(),
  contact_person: z.string().trim().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  phone: z.string().trim().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  status: leadStatus.optional(),
  estimated_value: z.number().optional().nullable(),
  currency: z.string().trim().optional().nullable(),
  notes: z.string().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
});

const updateLeadSchema = createLeadSchema.partial();

// GET /api/leads — list with optional status/search filters
router.get('/', async (req, res) => {
  const { status, search, page = '1', limit = '50' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);

  let query = supabase
    .from('leads')
    .select('*, assignee:users!leads_assigned_to_fkey(id, full_name), creator:users!leads_created_by_fkey(id, full_name)', { count: 'exact' });

  if (status && status !== 'all') query = query.eq('status', String(status));
  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) {
      query = query.or(`lead_name.ilike.%${s}%,company_name.ilike.%${s}%,email.ilike.%${s}%,contact_person.ilike.%${s}%`);
    }
  }

  query = query.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [], total: count || 0, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /api/leads/stats — counts by status
router.get('/stats', async (_req, res) => {
  const { data, error } = await supabase.from('leads').select('status');
  if (error) return res.status(500).json({ error: error.message });
  const by: Record<string, number> = {};
  for (const row of data || []) by[row.status] = (by[row.status] || 0) + 1;
  res.json({ total: (data || []).length, by_status: by });
});

// GET /api/leads/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*, assignee:users!leads_assigned_to_fkey(id, full_name), creator:users!leads_created_by_fkey(id, full_name)')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Lead not found' });
  res.json(data);
});

// POST /api/leads
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('leads')
    .insert({ ...parsed.data, created_by: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/leads/:id
router.put('/:id', async (req, res) => {
  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('leads')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Lead not found' });
  res.json(data);
});

// POST /api/leads/:id/convert — create a buyer from this lead
router.post('/:id/convert', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status === 'converted' && lead.converted_buyer_id) {
    return res.status(400).json({ error: 'Lead is already converted' });
  }

  const { data: buyer, error: buyerErr } = await supabase
    .from('buyers')
    .insert({
      buyer_name: lead.company_name || lead.lead_name,
      contact_person: lead.contact_person || lead.lead_name,
      contact_email: lead.email,
      contact_phone: lead.phone,
      description: lead.notes ? `Converted from lead. ${lead.notes}` : 'Converted from lead.',
    })
    .select()
    .single();

  if (buyerErr) return res.status(500).json({ error: buyerErr.message });

  const { data: updated, error: updErr } = await supabase
    .from('leads')
    .update({ status: 'converted', converted_buyer_id: buyer.id, converted_at: new Date().toISOString() })
    .eq('id', lead.id)
    .select()
    .single();

  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json({ lead: updated, buyer });
});

// DELETE /api/leads/:id — manager/super_admin, or the creator of the lead
router.delete('/:id', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;

  const { data: lead } = await supabase.from('leads').select('id, created_by').eq('id', req.params.id).maybeSingle();
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const isPrivileged = role === 'manager' || role === 'super_admin';
  if (!isPrivileged && lead.created_by !== userId) {
    return res.status(403).json({ error: 'You can only delete leads you created' });
  }

  const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerLeadRoutes(api: express.Router) {
  api.use('/leads', router);
}
