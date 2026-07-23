import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { creditWarningIfExceeded } from '../utils/buyerCredit.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const enquiryStage = z.enum([
  'new_enquiry',
  'under_review',
  'preparing',
  'quote_sent',
  'follow_up',
  'won_closed',
  'lost_closed',
]);

const priorityEnum = z.enum(['low', 'medium', 'high']);

const createEnquirySchema = z.object({
  title: z.string().trim().optional().nullable(),
  requirement: z.string().trim().min(10),
  project_id: z.string().uuid().optional().nullable(),
  standalone_project_name: z.string().trim().min(1).optional().nullable(),
  owner_id: z.string().uuid().optional().nullable(),
  buyer_id: z.string().uuid().optional().nullable(),
  client_email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  prospect_name: z.string().trim().optional().nullable(),
  opportunity_id: z.string().uuid().optional().nullable(),
  client_budget: z.number().optional().nullable(),
  client_currency: z.string().trim().optional().nullable(),
  client_price_notes: z.string().optional().nullable(),
  deadline: z.string().optional().nullable(),
  priority: priorityEnum.optional(),
  stage: enquiryStage.optional(),
  notes: z.string().optional().nullable(),
  outcome: z.string().optional().nullable(),
});

const updateEnquirySchema = createEnquirySchema.partial();

async function logActivity(userId: string, action: string, entityId?: string, meta?: Record<string, unknown>) {
  await supabase.from('activity_logs').insert({
    user_id: userId,
    action,
    table_name: 'enquiries',
    record_id: entityId || null,
    details: meta || null,
  });
}

function sanitizeIlikeSearch(raw: unknown): string {
  return String(raw || '')
    .replace(/[%_,()]/g, ' ')
    .trim();
}

// GET /api/enquiries
router.get('/', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;
  const { stage, search, page = '1', limit = '50' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);

  let query = supabase
    .from('enquiries')
    .select(
      '*, owner:users!enquiries_owner_id_fkey(id, full_name), creator:users!enquiries_created_by_fkey(id, full_name), buyer:buyers!enquiries_buyer_id_fkey(id, buyer_name)',
      { count: 'exact' },
    );

  if (stage && stage !== 'all') query = query.eq('stage', String(stage));
  if (search) {
    const s = sanitizeIlikeSearch(search);
    if (s) {
      query = query.or(
        `enquiry_number.ilike.%${s}%,title.ilike.%${s}%,requirement.ilike.%${s}%,standalone_project_name.ilike.%${s}%,prospect_name.ilike.%${s}%,client_email.ilike.%${s}%`,
      );
    }
  }

  if (role === 'user' && userId) {
    query = query.or(`created_by.eq.${userId},owner_id.eq.${userId}`);
  }

  query = query.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) {
    // Fallback without relationship aliases if FK names differ
    let fallback = supabase.from('enquiries').select('*', { count: 'exact' });
    if (stage && stage !== 'all') fallback = fallback.eq('stage', String(stage));
    if (search) {
      const s = sanitizeIlikeSearch(search);
      if (s) {
        fallback = fallback.or(
          `enquiry_number.ilike.%${s}%,title.ilike.%${s}%,requirement.ilike.%${s}%,standalone_project_name.ilike.%${s}%`,
        );
      }
    }
    if (role === 'user' && userId) {
      fallback = fallback.or(`created_by.eq.${userId},owner_id.eq.${userId}`);
    }
    fallback = fallback.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);
    const fb = await fallback;
    if (fb.error) return res.status(500).json({ error: fb.error.message });
    return res.json({
      data: fb.data || [],
      total: fb.count || 0,
      page: p,
      limit: l,
      totalPages: Math.ceil((fb.count || 0) / l),
    });
  }

  res.json({
    data: data || [],
    total: count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

// GET /api/enquiries/stats
router.get('/stats', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;

  let query = supabase.from('enquiries').select('stage');
  if (role === 'user' && userId) {
    query = query.or(`created_by.eq.${userId},owner_id.eq.${userId}`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const by: Record<string, number> = {};
  for (const row of data || []) by[row.stage] = (by[row.stage] || 0) + 1;
  res.json({ total: (data || []).length, by_stage: by });
});

// GET /api/enquiries/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('enquiries').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Enquiry not found' });

  const role = req.user?.role;
  const userId = req.user?.id;
  if (role === 'user' && userId && data.created_by !== userId && data.owner_id !== userId) {
    return res.status(403).json({ error: 'You do not have access to this enquiry' });
  }

  const [{ data: quotations }, { data: owner }, { data: buyer }, { data: project }] = await Promise.all([
    supabase
      .from('quotations')
      .select('id, quotation_number, status, quote_sent_at, created_at, clarusto_final_price, revised_price')
      .eq('enquiry_id', data.id)
      .order('created_at', { ascending: false }),
    data.owner_id
      ? supabase.from('users').select('id, full_name, email').eq('id', data.owner_id).maybeSingle()
      : Promise.resolve({ data: null } as any),
    data.buyer_id
      ? supabase.from('buyers').select('id, buyer_name, contact_email').eq('id', data.buyer_id).maybeSingle()
      : Promise.resolve({ data: null } as any),
    data.project_id
      ? supabase.from('projects').select('id, project_id, project_name').eq('id', data.project_id).maybeSingle()
      : Promise.resolve({ data: null } as any),
  ]);

  res.json({
    ...data,
    quotations: quotations || [],
    owner: owner || null,
    buyer: buyer || null,
    project: project || null,
  });
});

// POST /api/enquiries
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createEnquirySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  if (!parsed.data.project_id && !parsed.data.standalone_project_name?.trim() && !parsed.data.buyer_id && !parsed.data.prospect_name?.trim()) {
    // Soft rule: allow create with just requirement; no hard fail
  }

  const { data, error } = await supabase
    .from('enquiries')
    .insert({
      ...parsed.data,
      owner_id: parsed.data.owner_id || userId,
      created_by: userId,
      updated_by: userId,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await logActivity(userId, `created enquiry ${data.enquiry_number}`, data.id);
  res.status(201).json(data);
});

// PUT /api/enquiries/:id
router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = updateEnquirySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: existing } = await supabase
    .from('enquiries')
    .select('id, created_by, owner_id, enquiry_number')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  const role = req.user?.role;
  const isPrivileged = role === 'manager' || role === 'super_admin';
  if (!isPrivileged && existing.created_by !== userId && existing.owner_id !== userId) {
    return res.status(403).json({ error: 'You can only edit enquiries you created or own' });
  }

  const { data, error } = await supabase
    .from('enquiries')
    .update({ ...parsed.data, updated_by: userId })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || 'Update failed' });

  await logActivity(userId, `updated enquiry ${existing.enquiry_number}`, data.id);
  res.json(data);
});

// POST /api/enquiries/:id/convert — Create Quotation from Enquiry
router.post('/:id/convert', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data: enquiry, error: enqErr } = await supabase
    .from('enquiries')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (enqErr || !enquiry) return res.status(404).json({ error: 'Enquiry not found' });

  const role = req.user?.role;
  const isPrivileged = role === 'manager' || role === 'super_admin';
  if (!isPrivileged && enquiry.created_by !== userId && enquiry.owner_id !== userId) {
    return res.status(403).json({ error: 'You can only convert enquiries you created or own' });
  }

  const requirement = (enquiry.requirement || '').trim();
  if (requirement.length < 10) {
    return res.status(400).json({ error: 'Enquiry requirement must be at least 10 characters before creating a quotation' });
  }

  // Standalone quotations require budget when no project
  if (!enquiry.project_id && (enquiry.client_budget == null || Number.isNaN(Number(enquiry.client_budget)))) {
    return res.status(400).json({
      error: 'Set a client budget on the enquiry (or link a project) before creating a quotation',
    });
  }

  const quotationPayload: Record<string, unknown> = {
    requirement,
    status: 'waiting_from_companies',
    enquiry_lead: enquiry.owner_id || userId,
    project_id: enquiry.project_id,
    standalone_project_name: enquiry.standalone_project_name,
    client_budget: enquiry.client_budget,
    client_currency: enquiry.client_currency || 'INR',
    client_price_notes: enquiry.client_price_notes,
    deadline: enquiry.deadline,
    enquiry_title: enquiry.title || enquiry.prospect_name || enquiry.standalone_project_name,
    enquiry_stage: enquiry.stage === 'new_enquiry' || enquiry.stage === 'under_review' ? 'preparing' : enquiry.stage,
    priority: enquiry.priority || 'medium',
    tracker_remarks: enquiry.notes,
    buyer_id: enquiry.buyer_id,
    client_email: enquiry.client_email,
    enquiry_id: enquiry.id,
    opportunity_id: enquiry.opportunity_id || null,
    created_by: userId,
    updated_by: userId,
  };

  const { data: quotation, error: qErr } = await supabase
    .from('quotations')
    .insert(quotationPayload)
    .select()
    .single();

  if (qErr) return res.status(500).json({ error: qErr.message });

  // Advance enquiry toward preparing if still early
  let nextStage = enquiry.stage;
  if (enquiry.stage === 'new_enquiry' || enquiry.stage === 'under_review') {
    nextStage = 'preparing';
  }

  const { data: updatedEnquiry } = await supabase
    .from('enquiries')
    .update({ stage: nextStage, updated_by: userId })
    .eq('id', enquiry.id)
    .select()
    .single();

  await logActivity(userId, `created quotation ${quotation.quotation_number} from enquiry ${enquiry.enquiry_number}`, enquiry.id, {
    quotation_id: quotation.id,
  });

  const estimated =
    enquiry.client_budget != null && !Number.isNaN(Number(enquiry.client_budget))
      ? Number(enquiry.client_budget)
      : null;
  const credit_warning = await creditWarningIfExceeded(
    enquiry.buyer_id ? String(enquiry.buyer_id) : null,
    estimated,
  );

  res.status(201).json({
    enquiry: updatedEnquiry || enquiry,
    quotation,
    ...(credit_warning ? { credit_warning } : {}),
  });
});

// DELETE /api/enquiries/:id
router.delete('/:id', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;

  const { data: enquiry } = await supabase
    .from('enquiries')
    .select('id, created_by, enquiry_number')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });

  const isPrivileged = role === 'manager' || role === 'super_admin';
  if (!isPrivileged && enquiry.created_by !== userId) {
    return res.status(403).json({ error: 'You can only delete enquiries you created' });
  }

  const { error } = await supabase.from('enquiries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  if (userId) {
    await logActivity(userId, `deleted enquiry ${enquiry.enquiry_number}`, enquiry.id);
  }

  res.json({ success: true });
});

export function registerEnquiryRoutes(api: express.Router) {
  api.use('/enquiries', router);
}
