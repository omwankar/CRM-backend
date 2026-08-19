import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { buildQuotationPdfBuffer, type QuotationPdfData } from '../services/quotationPdf.js';
import { sendQuotationEmail } from '../services/quotationEmail.js';
import { resolveInvoiceLogoPath } from '../services/invoicePdf.js';
import { getQuotationCustomerPrice } from '../utils/quotationPricing.js';
import { creditWarningIfExceeded } from '../utils/buyerCredit.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// All authenticated users (including employees) can create and work on
// quotations/enquiries. Deletes stay restricted via requireRole below.
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

const enquiryStage = z.enum([
  'new_enquiry',
  'under_review',
  'preparing',
  'quote_sent',
  'follow_up',
  'won_closed',
  'lost_closed',
]);

const createQuotationSchema = z.object({
  enquiry_id: z.string().uuid(),
  requirement: z.string().min(10).optional(), // inherited from enquiry if omitted
  status: quotationStatus.optional(),
  opportunity_id: z.string().uuid().optional().nullable(),
  enquiry_lead: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  standalone_project_name: z.string().trim().min(1).optional().nullable(),
  client_budget: z.number().optional().nullable(),
  client_currency: z.string().optional().nullable(),
  client_price_notes: z.string().optional().nullable(),
  deadline: z.string().optional().nullable(),
  enquiry_title: z.string().optional().nullable(),
  enquiry_stage: enquiryStage.optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  outcome: z.string().optional().nullable(),
  tracker_remarks: z.string().optional().nullable(),
  buyer_id: z.string().uuid().optional().nullable(),
  client_email: z.string().email().optional().nullable(),
});

const updateQuotationSchema = createQuotationSchema.partial().extend({
  enquiry_id: z.string().uuid().optional(), // allow but prefer not to reparent
  buyer_id: z.string().uuid().optional().nullable(),
  client_email: z.string().email().optional().nullable(),
  chosen_quote_id: z.string().uuid().optional().nullable(),
  clarusto_final_price: z.number().optional().nullable(),
  clarusto_final_currency: z.string().optional().nullable(),
  clarusto_final_notes: z.string().optional().nullable(),
  clarusto_quote_sent_at: z.string().optional().nullable(),
  revised_price: z.number().optional().nullable(),
  revised_currency: z.string().optional().nullable(),
  revised_notes: z.string().optional().nullable(),
  requirement: z.string().min(10).optional(),
  status: quotationStatus.optional(),
});

const sendQuotationSchema = z.object({
  email: z.string().email(),
  message: z.string().max(4000).optional().nullable(),
});

const COMPANY_SETTINGS_KEY = 'invoice_company';

function companyFromEnv() {
  return {
    name: process.env.COMPANY_NAME?.trim() || 'Company',
    phone: process.env.COMPANY_PHONE?.trim() || '',
    address: process.env.COMPANY_ADDRESS?.trim() || '',
    vat_number: process.env.COMPANY_VAT_NUMBER?.trim() || '',
  };
}

async function loadCompanySettings() {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', COMPANY_SETTINGS_KEY)
    .maybeSingle();
  if (data?.value && typeof data.value === 'object') {
    const v = data.value as Record<string, string>;
    return {
      name: v.name || companyFromEnv().name,
      phone: v.phone ?? companyFromEnv().phone,
      address: v.address ?? companyFromEnv().address,
      vat_number: v.vat_number ?? companyFromEnv().vat_number,
    };
  }
  return companyFromEnv();
}

async function buildQuotationPdfForRecord(quotation: Record<string, unknown>, buyer: Record<string, unknown> | null) {
  const price = getQuotationCustomerPrice(quotation as Parameters<typeof getQuotationCustomerPrice>[0]);
  if (!price) {
    throw new Error('Set a customer send price (finalize or revise quotation) before sending or downloading the quote PDF.');
  }

  const company = await loadCompanySettings();
  const projectName =
    (quotation.standalone_project_name as string | null) ||
    ((quotation.projects as { project_name?: string } | null)?.project_name ?? null);

  const pdfData: QuotationPdfData = {
    quotation_number: String(quotation.quotation_number),
    issue_date: new Date().toISOString().slice(0, 10),
    valid_until: (quotation.deadline as string | null) || null,
    currency: price.currency,
    amount: price.amount,
    requirement: String(quotation.requirement),
    notes: price.notes,
    project_name: projectName,
    company_name: company.name,
    company_address: company.address,
    company_phone: company.phone || null,
    company_vat_number: company.vat_number || null,
    logo_path: resolveInvoiceLogoPath(),
    client: {
      name: (buyer?.buyer_name as string) || projectName || 'Client',
      contact_person: (buyer?.contact_person as string | null) ?? null,
      contact_email: (buyer?.contact_email as string | null) ?? (quotation.client_email as string | null),
      address: (buyer?.address as string | null) ?? null,
    },
  };

  return buildQuotationPdfBuffer(pdfData);
}

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
  vendor_quote_number: z.string().optional().nullable(),
  validity_date: z.string().optional().nullable(),
  quote_file_url: z.string().max(2048).optional().nullable(),
  quote_line_status: z.enum(['under_review', 'sent', 'finalised']).optional(),
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

function sanitizeIlikeSearch(raw: unknown) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// GET /api/quotations
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role || 'employee';
    const { status, project_id, enquiry_lead, search, from_deadline, to_deadline, page = '1', limit = '20' } = req.query;

    const p = Math.max(1, Number(page));
    const l = Math.min(100, Number(limit));

    // List view: keep select simple to avoid schema-cache relationship issues.
    // Detail view fetches joins.
    let query = supabase.from('quotations').select('*', { count: 'exact' });

    if (status) query = query.eq('status', status as string);
    if (project_id) query = query.eq('project_id', project_id as string);
    if (enquiry_lead) query = query.eq('enquiry_lead', enquiry_lead as string);
    if (from_deadline) query = query.gte('deadline', String(from_deadline));
    if (to_deadline) query = query.lte('deadline', String(to_deadline));
    if (search) {
      const s = sanitizeIlikeSearch(search);
      if (s) {
        query = query.or(
          `quotation_number.ilike.%${s}%,requirement.ilike.%${s}%,enquiry_title.ilike.%${s}%,standalone_project_name.ilike.%${s}%`,
        );
      }
    }

    // Permission guard: plain users see quotations they created, lead, or are
    // assigned to via a project. Managers and super_admins see everything.
    if (role === 'user' && userId) {
      // We cannot do a join + EXISTS easily with the JS client, so we fetch project_ids they can see and filter.
      const { data: projectEmp } = await supabase
        .from('project_employees')
        .select('project_id')
        .eq('user_id', userId);
      const allowedProjects = (projectEmp || []).map((x: any) => x.project_id).filter(Boolean);
      query = query.or(
        `created_by.eq.${userId},enquiry_lead.eq.${userId},project_id.in.(${allowedProjects.join(',') || '00000000-0000-0000-0000-000000000000'})`,
      );
    }

    query = query
      .order('created_at', { ascending: false })
      .range((p - 1) * l, (p - 1) * l + l - 1);

    const { data, count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const leadIds = Array.from(
      new Set((data || []).map((q: any) => q.enquiry_lead).filter(Boolean)),
    );
    const rawProjectIds = Array.from(
      new Set((data || []).map((q: any) => q.project_id).filter(Boolean)),
    );
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const projectUuidIds = rawProjectIds.filter((v: any) => typeof v === 'string' && uuidRe.test(v));
    const projectCodeIds = rawProjectIds.filter((v: any) => typeof v === 'string' && !uuidRe.test(v));

    const [{ data: leads, error: leadsErr }, { data: projects, error: projectsErr }] =
      await Promise.all([
        leadIds.length
          ? supabase.from('users').select('id, full_name, avatar_url').in('id', leadIds)
          : Promise.resolve({ data: [], error: null } as any),
        rawProjectIds.length
          ? (async () => {
              const results: any[] = [];
              if (projectUuidIds.length) {
                const { data: byId, error } = await supabase
                  .from('projects')
                  .select('id, project_id, project_name')
                  .in('id', projectUuidIds);
                if (error) return { data: null, error };
                results.push(...(byId || []));
              }
              if (projectCodeIds.length) {
                const { data: byCode, error } = await supabase
                  .from('projects')
                  .select('id, project_id, project_name')
                  .in('project_id', projectCodeIds);
                if (error) return { data: null, error };
                results.push(...(byCode || []));
              }
              return { data: results, error: null };
            })()
          : Promise.resolve({ data: [], error: null } as any),
      ]);

    if (leadsErr) return res.status(500).json({ error: leadsErr.message });
    if (projectsErr) return res.status(500).json({ error: projectsErr.message });

    const quotationIds = (data || []).map((q: any) => q.id).filter(Boolean);
    const { data: vendorQuoteRows, error: vendorQuoteErr } = quotationIds.length
      ? await supabase
          .from('quotation_vendor_quotes')
          .select('quotation_id')
          .in('quotation_id', quotationIds)
      : { data: [], error: null as any };

    if (vendorQuoteErr) return res.status(500).json({ error: vendorQuoteErr.message });

    const vendorCountByQuotationId = new Map<string, number>();
    for (const r of vendorQuoteRows || []) {
      const qid = (r as any).quotation_id as string;
      vendorCountByQuotationId.set(qid, (vendorCountByQuotationId.get(qid) || 0) + 1);
    }

    const leadsById = new Map((leads || []).map((u: any) => [u.id, u]));
    const projectsById = new Map((projects || []).map((p: any) => [p.id, p]));
    const projectsByCode = new Map((projects || []).map((p: any) => [p.project_id, p]));

    res.json({
      data: (data || []).map((q: any) => ({
        ...q,
        users: q.enquiry_lead ? leadsById.get(q.enquiry_lead) || null : null,
        projects: q.project_id
          ? projectsById.get(q.project_id) || projectsByCode.get(q.project_id) || null
          : null,
        vendor_quotes_count: vendorCountByQuotationId.get(q.id) || 0,
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

  const role = req.user?.role;
  const userId = req.user?.id;
  if (role === 'user' && userId) {
    const owns =
      quotation.created_by === userId ||
      quotation.enquiry_lead === userId;
    if (!owns && quotation.project_id) {
      const { data: member } = await supabase
        .from('project_employees')
        .select('project_id')
        .eq('project_id', quotation.project_id)
        .eq('user_id', userId)
        .maybeSingle();
      if (!member) return res.status(403).json({ error: 'You do not have access to this quotation' });
    } else if (!owns) {
      return res.status(403).json({ error: 'You do not have access to this quotation' });
    }
  }

  const [vendorQuotes, revisions, leadUser, project, updatedByUser, linkedInvoices, buyerRow, enquiryRow] =
    await Promise.all([
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
      ? supabase
          .from('users')
          .select('id, full_name, avatar_url, email, phone')
          .eq('id', quotation.enquiry_lead)
          .maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
    quotation.project_id
      ? supabase.from('projects').select('id, project_name').eq('id', quotation.project_id).maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
    (quotation as any).updated_by
      ? supabase.from('users').select('id, full_name, email').eq('id', (quotation as any).updated_by).maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
    supabase
      .from('invoices')
      .select('id, invoice_number, status, total, currency, created_at')
      .eq('quotation_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    (quotation as any).buyer_id
      ? supabase
          .from('buyers')
          .select('id, buyer_name, contact_person, contact_email, address, city, state, postal_code, country')
          .eq('id', (quotation as any).buyer_id)
          .is('deleted_at', null)
          .maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
    (quotation as any).enquiry_id
      ? supabase
          .from('enquiries')
          .select('id, enquiry_number, title, stage, priority, deadline, client_budget, client_currency, opportunity_id, buyer_id')
          .eq('id', (quotation as any).enquiry_id)
          .maybeSingle()
      : Promise.resolve({ data: null as any, error: null as any }),
  ]);

  if (vendorQuotes.error) return res.status(500).json({ error: vendorQuotes.error.message });
  if (revisions.error) return res.status(500).json({ error: revisions.error.message });
  if (leadUser.error) return res.status(500).json({ error: leadUser.error.message });
  if (project.error) return res.status(500).json({ error: project.error.message });
  if (updatedByUser.error) return res.status(500).json({ error: updatedByUser.error.message });
  if (linkedInvoices.error) return res.status(500).json({ error: linkedInvoices.error.message });
  if (buyerRow.error) return res.status(500).json({ error: buyerRow.error.message });
  if (enquiryRow.error) return res.status(500).json({ error: enquiryRow.error.message });

  res.json({
    ...quotation,
    users: leadUser.data || null,
    projects: project.data || null,
    buyer: buyerRow.data || null,
    enquiry: enquiryRow.data || null,
    linked_invoices: linkedInvoices.data || [],
    quotation_vendor_quotes: vendorQuotes.data || [],
    quotation_revisions: revisions.data || [],
    updated_by_user: updatedByUser.data || null,
  });
});

// GET /api/quotations/:id/pdf
router.get('/:id/pdf', async (req, res) => {
  const { data: quotation, error } = await supabase.from('quotations').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!quotation) return res.status(404).json({ error: 'Not found' });

  let buyer: Record<string, unknown> | null = null;
  if ((quotation as { buyer_id?: string }).buyer_id) {
    const { data } = await supabase
      .from('buyers')
      .select('*')
      .eq('id', (quotation as { buyer_id: string }).buyer_id)
      .is('deleted_at', null)
      .maybeSingle();
    buyer = data;
  }

  try {
    const buffer = await buildQuotationPdfForRecord(quotation, buyer);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quotation.quotation_number}.pdf"`);
    res.send(buffer);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'PDF generation failed' });
  }
});

// POST /api/quotations/:id/send — email quote PDF to client
router.post('/:id/send', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = sendQuotationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const { data: quotation, error } = await supabase.from('quotations').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!quotation) return res.status(404).json({ error: 'Not found' });

  const price = getQuotationCustomerPrice(quotation);
  if (!price) {
    return res.status(400).json({
      error: 'Set a customer send price (finalize enquiry or add a revision) before sending the quote.',
    });
  }

  let buyer: Record<string, unknown> | null = null;
  if (quotation.buyer_id) {
    const { data } = await supabase
      .from('buyers')
      .select('*')
      .eq('id', quotation.buyer_id)
      .is('deleted_at', null)
      .maybeSingle();
    buyer = data;
  }

  const clientName =
    (buyer?.buyer_name as string) ||
    quotation.standalone_project_name ||
    quotation.enquiry_title ||
    'Client';

  try {
    const pdfBuffer = await buildQuotationPdfForRecord(quotation, buyer);
    const emailResult = await sendQuotationEmail({
      to: parsed.data.email,
      quotationNumber: quotation.quotation_number,
      clientName,
      total: price.amount,
      currency: price.currency,
      pdfBuffer,
      pdfFilename: `${quotation.quotation_number}.pdf`,
      message: parsed.data.message,
    });

    const sentAt = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from('quotations')
      .update({
        quote_sent_to_email: parsed.data.email,
        quote_sent_at: sentAt,
        quote_email_message_id: emailResult.id,
        clarusto_quote_sent_at: quotation.clarusto_quote_sent_at || sentAt,
        enquiry_stage: quotation.enquiry_stage === 'new_enquiry' ? 'quote_sent' : quotation.enquiry_stage,
        client_email: parsed.data.email,
        updated_by: userId,
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updErr || !updated) return res.status(500).json({ error: updErr?.message || 'Failed to update quotation' });

    // Advance linked enquiry stage to quote_sent when a quotation is emailed
    if (quotation.enquiry_id) {
      const { data: linkedEnquiry } = await supabase
        .from('enquiries')
        .select('id, stage')
        .eq('id', quotation.enquiry_id)
        .maybeSingle();

      if (
        linkedEnquiry &&
        !['quote_sent', 'follow_up', 'won_closed', 'lost_closed'].includes(linkedEnquiry.stage)
      ) {
        await supabase
          .from('enquiries')
          .update({ stage: 'quote_sent', updated_by: userId })
          .eq('id', linkedEnquiry.id);
      }
    }

    await logActivity(userId, `sent quotation ${quotation.quotation_number} to ${parsed.data.email}`, req.params.id, {
      email: parsed.data.email,
    });

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to send quotation' });
  }
});

// POST /api/quotations — requires enquiry_id; inherits opportunity/buyer + denormalized enquiry fields
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createQuotationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: enquiry, error: eErr } = await supabase
    .from('enquiries')
    .select('*')
    .eq('id', parsed.data.enquiry_id)
    .maybeSingle();
  if (eErr) return res.status(500).json({ error: eErr.message });
  if (!enquiry) return res.status(400).json({ error: 'Enquiry not found' });

  const requirement =
    parsed.data.requirement?.trim() ||
    enquiry.requirement ||
    '';
  if (requirement.length < 10) {
    return res.status(400).json({ error: 'Enquiry requirement must be at least 10 characters' });
  }

  let opportunityId = parsed.data.opportunity_id ?? enquiry.opportunity_id ?? null;
  let buyerId = parsed.data.buyer_id ?? enquiry.buyer_id ?? null;

  if (opportunityId) {
    const { data: opp } = await supabase
      .from('opportunities')
      .select('id, buyer_id')
      .eq('id', opportunityId)
      .maybeSingle();
    if (opp?.buyer_id) buyerId = opp.buyer_id;
  }

  const payload: Record<string, unknown> = {
    enquiry_id: enquiry.id,
    opportunity_id: opportunityId,
    buyer_id: buyerId,
    requirement,
    status: parsed.data.status || 'waiting_from_companies',
    enquiry_lead: parsed.data.enquiry_lead ?? enquiry.owner_id ?? userId,
    project_id: parsed.data.project_id ?? enquiry.project_id,
    standalone_project_name: parsed.data.standalone_project_name ?? enquiry.standalone_project_name,
    client_budget: parsed.data.client_budget ?? enquiry.client_budget,
    client_currency: parsed.data.client_currency ?? enquiry.client_currency ?? 'INR',
    client_price_notes: parsed.data.client_price_notes ?? enquiry.client_price_notes,
    deadline: parsed.data.deadline ?? enquiry.deadline,
    enquiry_title:
      parsed.data.enquiry_title ??
      enquiry.title ??
      enquiry.prospect_name ??
      enquiry.standalone_project_name,
    enquiry_stage:
      parsed.data.enquiry_stage ??
      (enquiry.stage === 'new_enquiry' || enquiry.stage === 'under_review' ? 'preparing' : enquiry.stage),
    priority: parsed.data.priority ?? enquiry.priority ?? 'medium',
    outcome: parsed.data.outcome ?? null,
    tracker_remarks: parsed.data.tracker_remarks ?? enquiry.notes,
    client_email: parsed.data.client_email ?? enquiry.client_email,
    created_by: userId,
    updated_by: userId,
  };

  if (!payload.project_id && (payload.client_budget == null || Number.isNaN(Number(payload.client_budget)))) {
    return res.status(400).json({
      error: 'Client budget is required when the enquiry has no project',
    });
  }

  const { data, error } = await supabase.from('quotations').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const estimated =
    payload.client_budget != null && !Number.isNaN(Number(payload.client_budget))
      ? Number(payload.client_budget)
      : null;
  const credit_warning = await creditWarningIfExceeded(
    buyerId ? String(buyerId) : null,
    estimated,
  );

  // Advance early enquiry stages to preparing (never regress quote_sent+)
  if (enquiry.stage === 'new_enquiry' || enquiry.stage === 'under_review') {
    await supabase
      .from('enquiries')
      .update({ stage: 'preparing', updated_by: userId })
      .eq('id', enquiry.id);
  }

  await logActivity(userId, `created quotation ${data.quotation_number}`, data.id, {
    enquiry_id: enquiry.id,
  });

  res.status(201).json({ ...data, ...(credit_warning ? { credit_warning } : {}) });
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
    .update({ ...parsed.data, updated_by: userId })
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

  const insertPayload = { ...parsed.data, quote_file_url: parsed.data.quote_file_url || null };

  const { data, error } = await supabase
    .from('quotation_vendor_quotes')
    .insert({ quotation_id: req.params.id, ...insertPayload })
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

  const updatePayload = { ...parsed.data } as Record<string, unknown>;
  if (updatePayload.quote_file_url === '') updatePayload.quote_file_url = null;

  const { data, error } = await supabase
    .from('quotation_vendor_quotes')
    .update(updatePayload)
    .eq('id', req.params.quoteId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// DELETE /api/quotations/vendor-quotes/:quoteId
router.delete('/vendor-quotes/:quoteId', async (req, res) => {
  if (!requireRole(req, res, ['super_admin', 'manager'])) return;

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
    .update({ is_chosen: true, quote_line_status: 'finalised' })
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

