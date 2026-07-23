import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { sharedWriteGuard } from '../middleware/requireRole.js';
import { creditWarningIfExceeded } from '../utils/buyerCredit.js';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

router.use(authMiddleware);
router.use(sharedWriteGuard);

const JOB_STATUSES = [
  'booked',
  'in_transit',
  'arrived',
  'delivered',
  'pod_received',
  'closed',
  'cancelled',
] as const;

const MODE_TYPES = ['air', 'sea', 'road'] as const;

const createJobSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  opportunity_id: z.string().uuid('Opportunity is required'),
  quotation_id: z.string().uuid().nullable().optional(),
  invoice_id: z.string().uuid().nullable().optional(),
  buyer_id: z.string().uuid().nullable().optional(),
  origin: z.string().optional().nullable(),
  destination: z.string().optional().nullable(),
  cargo_description: z.string().optional().nullable(),
  weight_kg: z.number().nullable().optional(),
  volume_cbm: z.number().nullable().optional(),
  container_type: z.string().optional().nullable(),
  mode_type: z.enum(MODE_TYPES).nullable().optional(),
  status: z.enum(JOB_STATUSES).default('booked'),
  supervisor_id: z.string().uuid().nullable().optional(),
  assigned_person_id: z.string().uuid().nullable().optional(),
  linked_email: z.string().email().optional().or(z.literal('')).nullable(),
  notes: z.string().optional().nullable(),
  vendor_ids: z.array(z.string().uuid()).optional(),
  partnership_ids: z.array(z.string().uuid()).optional(),
  created_by: z.string().uuid(),
});

const updateJobSchema = z.object({
  title: z.string().min(1).optional(),
  quotation_id: z.string().uuid().nullable().optional(),
  invoice_id: z.string().uuid().nullable().optional(),
  buyer_id: z.string().uuid().nullable().optional(),
  origin: z.string().optional().nullable(),
  destination: z.string().optional().nullable(),
  cargo_description: z.string().optional().nullable(),
  weight_kg: z.number().nullable().optional(),
  volume_cbm: z.number().nullable().optional(),
  container_type: z.string().optional().nullable(),
  mode_type: z.enum(MODE_TYPES).nullable().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  supervisor_id: z.string().uuid().nullable().optional(),
  assigned_person_id: z.string().uuid().nullable().optional(),
  linked_email: z.string().email().optional().or(z.literal('')).nullable(),
  notes: z.string().optional().nullable(),
});

const changeStatusSchema = z.object({
  status: z.enum(JOB_STATUSES),
  reason: z.string().min(1, 'Reason is required'),
  changed_by: z.string().uuid().optional(),
});

function personPayload(user: { id: string; full_name?: string | null; email?: string | null } | null) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.full_name || user.email || 'Unknown',
    email: user.email || '',
  };
}

async function loadUsersById(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {} as Record<string, any>;
  const { data } = await supabase.from('users').select('id, email, full_name').in('id', unique);
  return (data || []).reduce((acc: Record<string, any>, u: any) => {
    acc[u.id] = u;
    return acc;
  }, {});
}

async function enrichJobRow(job: any) {
  const usersById = await loadUsersById(
    [job.assigned_person_id, job.supervisor_id, job.created_by].filter(Boolean)
  );

  let buyer = null;
  if (job.buyer_id) {
    const { data } = await supabase
      .from('buyers')
      .select('id, buyer_name, contact_email')
      .eq('id', job.buyer_id)
      .maybeSingle();
    buyer = data;
  }

  let opportunity = null;
  if (job.opportunity_id) {
    const { data } = await supabase
      .from('opportunities')
      .select('id, title, stage')
      .eq('id', job.opportunity_id)
      .maybeSingle();
    opportunity = data;
  }

  return {
    ...job,
    assigned_person: personPayload(usersById[job.assigned_person_id] || null),
    supervisor: personPayload(usersById[job.supervisor_id] || null),
    buyer,
    opportunity,
  };
}

// GET /api/jobs
router.get('/', async (req, res) => {
  try {
    const {
      status,
      search,
      opportunity_id,
      buyer_id,
      mode_type,
      sort_by,
      sort_order,
      page = '1',
      limit = '20',
    } = req.query;

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase.from('jobs').select('*', { count: 'exact' }).is('deleted_at', null);

    if (status) query = query.eq('status', status);
    if (opportunity_id) query = query.eq('opportunity_id', opportunity_id);
    if (buyer_id) query = query.eq('buyer_id', buyer_id);
    if (mode_type) query = query.eq('mode_type', mode_type);
    if (search) {
      query = query.or(
        `title.ilike.%${search}%,job_number.ilike.%${search}%,origin.ilike.%${search}%,destination.ilike.%${search}%`
      );
    }

    const allowedSort = new Set(['created_at', 'updated_at', 'job_number', 'title', 'status']);
    const sortBy = allowedSort.has(String(sort_by || '')) ? String(sort_by) : 'created_at';
    const ascending = String(sort_order || 'desc') === 'asc';
    query = query.order(sortBy, { ascending }).range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const jobs = await Promise.all((data || []).map(enrichJobRow));

    res.json({
      jobs,
      total: count || 0,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil((count || 0) / limitNum),
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/jobs/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: job, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error || !job) return res.status(404).json({ error: 'Job not found' });

    const enriched = await enrichJobRow(job);

    const [{ data: vendors }, { data: partners }, { data: attachments }, { data: emails }] =
      await Promise.all([
        supabase.from('job_vendors').select('id, vendor_id, notes, added_at').eq('job_id', id),
        supabase.from('job_partners').select('id, partnership_id, notes, added_at').eq('job_id', id),
        supabase
          .from('job_attachments')
          .select('*')
          .eq('job_id', id)
          .order('uploaded_at', { ascending: false }),
        supabase
          .from('job_emails')
          .select('*')
          .eq('job_id', id)
          .order('received_at', { ascending: false }),
      ]);

    const vendorIds = (vendors || []).map((v: any) => v.vendor_id);
    const partnerIds = (partners || []).map((p: any) => p.partnership_id);

    let vendorsById: Record<string, any> = {};
    let partnersById: Record<string, any> = {};

    if (vendorIds.length) {
      const { data } = await supabase
        .from('vendors')
        .select('id, vendor_name, contact_email, vendor_type')
        .in('id', vendorIds);
      vendorsById = (data || []).reduce((acc: any, v: any) => {
        acc[v.id] = v;
        return acc;
      }, {});
    }

    if (partnerIds.length) {
      const { data } = await supabase
        .from('partnerships')
        .select('id, partner_name, partner_type, status')
        .in('id', partnerIds);
      partnersById = (data || []).reduce((acc: any, p: any) => {
        acc[p.id] = p;
        return acc;
      }, {});
    }

    let quotation = null;
    let invoice = null;
    if (job.quotation_id) {
      const { data } = await supabase
        .from('quotations')
        .select('id, quotation_number, status')
        .eq('id', job.quotation_id)
        .maybeSingle();
      quotation = data;
    }
    if (job.invoice_id) {
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, status')
        .eq('id', job.invoice_id)
        .maybeSingle();
      invoice = data;
    }

    res.json({
      ...enriched,
      quotation,
      invoice,
      vendors: (vendors || []).map((v: any) => ({
        ...v,
        vendor: vendorsById[v.vendor_id] || null,
      })),
      partners: (partners || []).map((p: any) => ({
        ...p,
        partner: partnersById[p.partnership_id] || null,
      })),
      attachments: attachments || [],
      emails: emails || [],
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/jobs
router.post('/', async (req, res) => {
  try {
    const body = createJobSchema.parse(req.body);
    const { vendor_ids = [], partnership_ids = [], ...jobFields } = body;

    // Inherit buyer / quotation from opportunity when omitted
    let buyerId = jobFields.buyer_id ?? null;
    let quotationId = jobFields.quotation_id ?? null;
    let invoiceId = jobFields.invoice_id ?? null;

    const { data: opportunity, error: oppError } = await supabase
      .from('opportunities')
      .select('id, buyer_id, title, stage')
      .eq('id', jobFields.opportunity_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (oppError || !opportunity) {
      return res.status(400).json({ error: 'Opportunity not found' });
    }

    if (!buyerId) buyerId = opportunity.buyer_id;

    if (!quotationId) {
      const { data: quotes } = await supabase
        .from('quotations')
        .select('id')
        .eq('opportunity_id', opportunity.id)
        .order('created_at', { ascending: false })
        .limit(1);
      quotationId = quotes?.[0]?.id ?? null;
    }

    if (!invoiceId && quotationId) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('id')
        .eq('quotation_id', quotationId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1);
      invoiceId = invoices?.[0]?.id ?? null;
    }

    const insertPayload = {
      ...jobFields,
      buyer_id: buyerId,
      quotation_id: quotationId,
      invoice_id: invoiceId,
      linked_email: jobFields.linked_email || null,
      weight_kg: jobFields.weight_kg ?? null,
      volume_cbm: jobFields.volume_cbm ?? null,
    };

    const { data, error } = await supabase.from('jobs').insert(insertPayload).select().single();
    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('job_status_history').insert({
      job_id: data.id,
      old_status: null,
      new_status: body.status,
      reason: 'Job created',
      changed_by: body.created_by,
    });

    if (vendor_ids.length) {
      await supabase.from('job_vendors').insert(
        vendor_ids.map((vendor_id) => ({ job_id: data.id, vendor_id }))
      );
    }
    if (partnership_ids.length) {
      await supabase.from('job_partners').insert(
        partnership_ids.map((partnership_id) => ({ job_id: data.id, partnership_id }))
      );
    }

    const enriched = await enrichJobRow(data);

    // Soft credit warning when opportunity value would exceed buyer credit
    let credit_warning = null;
    if (buyerId) {
      const { data: oppVal } = await supabase
        .from('opportunities')
        .select('value')
        .eq('id', jobFields.opportunity_id)
        .maybeSingle();
      credit_warning = await creditWarningIfExceeded(buyerId, oppVal?.value != null ? Number(oppVal.value) : null);
    }

    res.status(201).json({ ...enriched, ...(credit_warning ? { credit_warning } : {}) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/jobs/:id
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = updateJobSchema.parse(req.body);

    const { data, error } = await supabase
      .from('jobs')
      .update({
        ...body,
        linked_email: body.linked_email === '' ? null : body.linked_email,
      })
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Job not found' });
    res.json(await enrichJobRow(data));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/jobs/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('jobs')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Job not found' });
    res.json({ message: 'Job deleted successfully' });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/jobs/:id/status
router.post('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const body = changeStatusSchema.parse(req.body);
    const actorId = body.changed_by || req.user?.id;
    if (!actorId) return res.status(401).json({ error: 'Unauthorized' });

    const { data: current } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (!current) return res.status(404).json({ error: 'Job not found' });

    const { data, error } = await supabase
      .from('jobs')
      .update({ status: body.status })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('job_status_history').insert({
      job_id: id,
      old_status: current.status,
      new_status: body.status,
      reason: body.reason,
      changed_by: actorId,
    });

    res.json(await enrichJobRow(data));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/jobs/:id/history
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('job_status_history')
      .select('id, old_status, new_status, reason, changed_by, changed_at')
      .eq('job_id', id)
      .order('changed_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const usersById = await loadUsersById((data || []).map((h: any) => h.changed_by).filter(Boolean));

    res.json(
      (data || []).map((h: any) => ({
        id: h.id,
        old_status: h.old_status,
        new_status: h.new_status,
        reason: h.reason,
        changed_by_name:
          usersById[h.changed_by]?.full_name || usersById[h.changed_by]?.email || 'Unknown',
        changed_at: h.changed_at,
      }))
    );
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendors
router.post('/:id/vendors', async (req, res) => {
  try {
    const { id } = req.params;
    const body = z
      .object({ vendor_id: z.string().uuid(), notes: z.string().optional().nullable() })
      .parse(req.body);

    const { data, error } = await supabase
      .from('job_vendors')
      .insert({ job_id: id, ...body })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/vendors/:vendorId', async (req, res) => {
  try {
    const { id, vendorId } = req.params;
    const { error } = await supabase
      .from('job_vendors')
      .delete()
      .eq('job_id', id)
      .eq('vendor_id', vendorId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Vendor removed' });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Partners
router.post('/:id/partners', async (req, res) => {
  try {
    const { id } = req.params;
    const body = z
      .object({ partnership_id: z.string().uuid(), notes: z.string().optional().nullable() })
      .parse(req.body);

    const { data, error } = await supabase
      .from('job_partners')
      .insert({ job_id: id, ...body })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/partners/:partnershipId', async (req, res) => {
  try {
    const { id, partnershipId } = req.params;
    const { error } = await supabase
      .from('job_partners')
      .delete()
      .eq('job_id', id)
      .eq('partnership_id', partnershipId);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Partner removed' });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Attachments
router.post('/:id/attachments', async (req, res) => {
  try {
    const { id } = req.params;
    const { file_name, file_type, file_url, file_size, uploaded_by } = req.body;

    const { data, error } = await supabase
      .from('job_attachments')
      .insert({ job_id: id, file_name, file_type, file_url, file_size, uploaded_by })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/attachments/:aid', async (req, res) => {
  try {
    const { id, aid } = req.params;
    const { error } = await supabase
      .from('job_attachments')
      .delete()
      .eq('id', aid)
      .eq('job_id', id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Attachment deleted' });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export function registerJobRoutes(api: express.Router) {
  api.use('/jobs', router);
}
