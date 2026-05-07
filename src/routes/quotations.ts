import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const quotationStatus = z.enum([
  'quote_given',
  'waiting_from_companies',
  'need_revision',
  'approved',
  'rejected',
  'cancelled',
]);

const createQuotationSchema = z.object({
  requirement: z.string().min(10),
  status: quotationStatus,
  enquiry_lead: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  client_budget: z.number().optional().nullable(),
  client_currency: z.string().optional().nullable(),
  client_price_notes: z.string().optional().nullable(),
  deadline: z.string().optional().nullable(),
});

const updateQuotationSchema = createQuotationSchema.partial().extend({
  chosen_quote_id: z.string().uuid().optional().nullable(),
  clarusto_final_price: z.number().optional().nullable(),
  clarusto_final_currency: z.string().optional().nullable(),
  clarusto_final_notes: z.string().optional().nullable(),
  clarusto_quote_sent_at: z.string().optional().nullable(),
  revised_price: z.number().optional().nullable(),
  revised_currency: z.string().optional().nullable(),
  revised_notes: z.string().optional().nullable(),
});

const vendorQuoteSchema = z.object({
  vendor_id: z.string().uuid().optional().nullable(),
  vendor_name: z.string().optional().nullable(),
  email_sent_to: z.string().email(),
  email_sent_at: z.string().optional().nullable(),
  email_thread_id: z.string().optional().nullable(),
  quoted_price: z.number().optional().nullable(),
  currency: z.string().optional().nullable(),
  quote_received_at: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const revisionSchema = z.object({
  revised_price: z.number(),
  currency: z.string(),
  notes: z.string().min(1),
});

function requireRole(req: express.Request, res: express.Response, allowed: string[]) {
  const role = req.user?.role;
  if (!role || !allowed.includes(role)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

async function logActivity(userId: string, action: string, recordId?: string, details?: any) {
  await supabase.from('activity_logs').insert({
    user_id: userId,
    action,
    table_name: 'quotations',
    record_id: recordId || null,
    details: details || null,
  });
}

// GET /api/quotations
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role || 'employee';
    const { status, project_id, enquiry_lead, search, page = '1', limit = '20' } = req.query;

    const p = Math.max(1, Number(page));
    const l = Math.min(100, Number(limit));

    // List view: keep select simple to avoid schema-cache relationship issues.
    // Detail view fetches joins.
    let query = supabase.from('quotations').select('*', { count: 'exact' });

    if (status) query = query.eq('status', status as string);
    if (project_id) query = query.eq('project_id', project_id as string);
    if (enquiry_lead) query = query.eq('enquiry_lead', enquiry_lead as string);
    if (search) {
      const s = String(search);
      query = query.or(`quotation_number.ilike.%${s}%,requirement.ilike.%${s}%`);
    }

    // UI/permission guard: employees can only see their own lead or linked project assignments
    if (role === 'employee' && userId) {
      // We cannot do a join + EXISTS easily with the JS client, so we fetch project_ids they can see and filter.
      const { data: projectEmp } = await supabase
        .from('project_employees')
        .select('project_id')
        .eq('user_id', userId);
      const allowedProjects = (projectEmp || []).map((x: any) => x.project_id).filter(Boolean);
      query = query.or(`enquiry_lead.eq.${userId},project_id.in.(${allowedProjects.join(',') || '00000000-0000-0000-0000-000000000000'})`);
    }

    query = query
      .order('created_at', { ascending: false })
      .range((p - 1) * l, (p - 1) * l + l - 1);

    const { data, count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      data: (data || []).map((q: any) => ({
        ...q,
        // Keep UI stable even without nested selects.
        quotation_vendor_quotes: q.quotation_vendor_quotes || [],
        quotation_revisions: q.quotation_revisions || [],
      })),
      total: count || 0,
      page: p,
      limit: l,
      totalPages: Math.ceil((count || 0) / l),
    });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/quotations/stats
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const today = new Date().toISOString().split('T')[0];

    const { count: total } = await supabase.from('quotations').select('*', { count: 'exact', head: true });
    const { data: byStatusRows } = await supabase.from('quotations').select('status');

    const by_status: Record<string, number> = {};
    for (const r of byStatusRows || []) {
      by_status[(r as any).status] = (by_status[(r as any).status] || 0) + 1;
    }

    const { count: overdue } = await supabase
      .from('quotations')
      .select('*', { count: 'exact', head: true })
      .lt('deadline', today)
      .in('status', ['waiting_from_companies', 'need_revision']);

    const { count: this_month } = await supabase
      .from('quotations')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', monthStart);

    res.json({ total: total || 0, by_status, overdue: overdue || 0, this_month: this_month || 0 });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/quotations/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  // Fetch base quotation first (avoid embed ambiguity entirely)
  const { data: quotation, error: qErr } = await supabase
    .from('quotations')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (qErr) return res.status(500).json({ error: qErr.message });
  if (!quotation) return res.status(404).json({ error: 'Not found' });

  const [vendorQuotes, revisions, leadUser, project] = await Promise.all([
    supabase
      .from('quotation_vendor_quotes')
      .select('*, vendors:vendors!quotation_vendor_quotes_vendor_id_fkey(id, vendor_name)')
      .eq('quotation_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('quotation_revisions')
      .select('*, users:users!quotation_revisions_revised_by_fkey(full_name)')
      .eq('quotation_id', id)
      .order('revision_number', { ascending: false }),
    quotation.enquiry_lead
      ? supabase.from('users').select('id, full_name, avatar_url').eq('id', quotation.enquiry_lead).maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
    quotation.project_id
      ? supabase.from('projects').select('id, project_name').eq('id', quotation.project_id).maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
  ]);

  if (vendorQuotes.error) return res.status(500).json({ error: vendorQuotes.error.message });
  if (revisions.error) return res.status(500).json({ error: revisions.error.message });
  if (leadUser.error) return res.status(500).json({ error: leadUser.error.message });
  if (project.error) return res.status(500).json({ error: project.error.message });

  res.json({
    ...quotation,
    users: leadUser.data || null,
    projects: project.data || null,
    quotation_vendor_quotes: vendorQuotes.data || [],
    quotation_revisions: revisions.data || [],
  });
});

// POST /api/quotations
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createQuotationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  // Standalone requires budget
  if (!parsed.data.project_id && (parsed.data.client_budget == null || Number.isNaN(parsed.data.client_budget as any))) {
    return res.status(400).json({ error: 'client_budget is required for standalone quotations' });
  }

  const { data, error } = await supabase
    .from('quotations')
    .insert({ ...parsed.data, created_by: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await logActivity(userId, `created quotation ${data.quotation_number}`, data.id);

  res.status(201).json(data);
});

// PUT /api/quotations/:id
router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = updateQuotationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: existing } = await supabase
    .from('quotations')
    .select('quotation_number,status')
    .eq('id', req.params.id)
    .maybeSingle();

  const { data, error } = await supabase
    .from('quotations')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });

  if (parsed.data.status && existing?.quotation_number) {
    await logActivity(userId, `updated status to ${parsed.data.status} on ${existing.quotation_number}`, data.id);
  } else if (existing?.quotation_number) {
    await logActivity(userId, `updated quotation ${existing.quotation_number}`, data.id);
  }

  res.json(data);
});

// DELETE /api/quotations/:id (super_admin only)
router.delete('/:id', async (req, res) => {
  if (!requireRole(req, res, ['super_admin'])) return;

  const { data, error } = await supabase
    .from('quotations')
    .delete()
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// POST /api/quotations/:id/vendor-quotes
router.post('/:id/vendor-quotes', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = vendorQuoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('quotation_vendor_quotes')
    .insert({ quotation_id: req.params.id, ...parsed.data })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await logActivity(userId, `added vendor quote to ${req.params.id}`, req.params.id, { vendor_id: parsed.data.vendor_id, vendor_name: parsed.data.vendor_name });

  res.status(201).json(data);
});

// PUT /api/quotations/vendor-quotes/:quoteId
router.put('/vendor-quotes/:quoteId', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = vendorQuoteSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('quotation_vendor_quotes')
    .update(parsed.data)
    .eq('id', req.params.quoteId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// DELETE /api/quotations/vendor-quotes/:quoteId
router.delete('/vendor-quotes/:quoteId', async (req, res) => {
  if (!requireRole(req, res, ['super_admin', 'admin'])) return;

  const { data, error } = await supabase
    .from('quotation_vendor_quotes')
    .delete()
    .eq('id', req.params.quoteId)
    .select()
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// POST /api/quotations/:id/choose-vendor-quote
router.post('/:id/choose-vendor-quote', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = z.object({ vendor_quote_id: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  const quotationId = req.params.id;
  const quoteId = parsed.data.vendor_quote_id;

  // Unchoose all
  await supabase
    .from('quotation_vendor_quotes')
    .update({ is_chosen: false })
    .eq('quotation_id', quotationId);

  // Choose selected
  const { data: chosen, error: chooseErr } = await supabase
    .from('quotation_vendor_quotes')
    .update({ is_chosen: true })
    .eq('id', quoteId)
    .eq('quotation_id', quotationId)
    .select()
    .single();

  if (chooseErr || !chosen) return res.status(400).json({ error: chooseErr?.message || 'Unable to choose quote' });

  const { data: updated, error } = await supabase
    .from('quotations')
    .update({ chosen_quote_id: quoteId })
    .eq('id', quotationId)
    .select()
    .single();

  if (error || !updated) return res.status(404).json({ error: 'Quotation not found' });

  await logActivity(userId, `chose vendor quote for ${updated.quotation_number}`, quotationId, { vendor_quote_id: quoteId });

  res.json(updated);
});

// POST /api/quotations/:id/revisions
router.post('/:id/revisions', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = revisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const quotationId = req.params.id;

  const { data: latest } = await supabase
    .from('quotation_revisions')
    .select('revision_number')
    .eq('quotation_id', quotationId)
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextRev = (latest?.revision_number || 0) + 1;

  const { data: rev, error: revErr } = await supabase
    .from('quotation_revisions')
    .insert({
      quotation_id: quotationId,
      revision_number: nextRev,
      revised_price: parsed.data.revised_price,
      currency: parsed.data.currency,
      notes: parsed.data.notes,
      revised_by: userId,
    })
    .select()
    .single();

  if (revErr) return res.status(500).json({ error: revErr.message });

  const { data: updated, error } = await supabase
    .from('quotations')
    .update({
      revised_price: parsed.data.revised_price,
      revised_currency: parsed.data.currency,
      revised_notes: parsed.data.notes,
      revised_at: new Date().toISOString(),
      revised_by: userId,
    })
    .eq('id', quotationId)
    .select()
    .single();

  if (error || !updated) return res.status(404).json({ error: 'Quotation not found' });

  await logActivity(userId, `added revision #${nextRev} to ${updated.quotation_number}`, quotationId);

  res.status(201).json({ revision: rev, quotation: updated });
});

export function registerQuotationRoutes(api: express.Router) {
  api.use('/quotations', router);
}

