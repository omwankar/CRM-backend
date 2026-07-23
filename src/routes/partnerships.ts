import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { sharedWriteGuard } from '../middleware/requireRole.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

const schema = z.object({
  partner_name: z.string().min(1),
  partner_company_name: z.string().optional().nullable(),
  partner_type: z.string().optional().nullable(),
  partnership_type: z.string().optional().nullable(),
  contact_person: z.string().optional().nullable(),
  contact_email: z.string().optional().nullable(),
  contact_phone: z.string().optional().nullable(),
  start_date: z.string().min(1),
  end_date: z.string().optional().nullable(),
  status: z.enum(['active', 'inactive', 'on_hold']).default('active'),
  description: z.string().optional().nullable(),
  terms_url: z.string().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
});

const updateSchema = schema.partial();

function normalizeTypes(body: {
  partner_type?: string | null;
  partnership_type?: string | null;
}) {
  const type = body.partnership_type || body.partner_type || null;
  return {
    partner_type: type,
    partnership_type: type,
  };
}

async function ensurePartnerCompanyType(companyId: string | null | undefined) {
  if (!companyId) return;
  const { data: company } = await supabase
    .from('companies')
    .select('company_types')
    .eq('id', companyId)
    .maybeSingle();
  if (company && !(company.company_types || []).includes('partner')) {
    await supabase
      .from('companies')
      .update({
        company_types: Array.from(new Set([...(company.company_types || []), 'partner'])),
      })
      .eq('id', companyId);
  }
}

router.get('/', async (req, res) => {
  const { search, status, partner_type, page = '1', limit = '20' } = req.query;
  let query = supabase
    .from('partnerships')
    .select('*, company:companies!partnerships_company_id_fkey(id, name, company_types)', {
      count: 'exact',
    })
    .is('deleted_at', null);

  if (status) query = query.eq('status', status);
  if (partner_type) {
    query = query.or(`partner_type.eq.${partner_type},partnership_type.eq.${partner_type}`);
  }
  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) {
      query = query.or(
        `partner_name.ilike.%${s}%,partner_company_name.ilike.%${s}%,contact_person.ilike.%${s}%`
      );
    }
  }

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /api/partnerships/:id/jobs — must be before /:id
router.get('/:id/jobs', async (req, res) => {
  const partnershipId = req.params.id;

  const { data: links, error: linkErr } = await supabase
    .from('job_partners')
    .select('id, job_id, notes, added_at')
    .eq('partnership_id', partnershipId)
    .order('added_at', { ascending: false });

  if (linkErr) return res.status(500).json({ error: linkErr.message });

  const jobIds = (links || []).map((l: any) => l.job_id).filter(Boolean);
  if (!jobIds.length) return res.json({ data: [] });

  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id, job_number, title, status, origin, destination, mode_type, buyer_id, created_at')
    .in('id', jobIds)
    .is('deleted_at', null);

  if (jobsErr) return res.status(500).json({ error: jobsErr.message });

  const byId = (jobs || []).reduce((acc: Record<string, any>, j: any) => {
    acc[j.id] = j;
    return acc;
  }, {});

  res.json({
    data: (links || [])
      .map((l: any) => ({
        link_id: l.id,
        notes: l.notes,
        added_at: l.added_at,
        job: byId[l.job_id] || null,
      }))
      .filter((row: any) => row.job),
  });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('partnerships')
    .select('*, company:companies!partnerships_company_id_fkey(*)')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Not found' });

  let sibling_vendors: Array<{ id: string; vendor_name: string }> = [];
  let sibling_buyers: Array<{ id: string; buyer_name: string }> = [];
  if (data.company_id) {
    const [{ data: vendors }, { data: buyers }] = await Promise.all([
      supabase
        .from('vendors')
        .select('id, vendor_name')
        .eq('company_id', data.company_id)
        .is('deleted_at', null),
      supabase
        .from('buyers')
        .select('id, buyer_name')
        .eq('company_id', data.company_id)
        .is('deleted_at', null),
    ]);
    sibling_vendors = vendors || [];
    sibling_buyers = buyers || [];
  }

  res.json({
    ...data,
    partner_type: data.partnership_type || data.partner_type,
    sibling_vendors,
    sibling_buyers,
    also_vendor: sibling_vendors.length > 0,
    also_buyer: sibling_buyers.length > 0,
  });
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const types = normalizeTypes(parsed.data);
  const payload = {
    ...parsed.data,
    ...types,
  };

  const { data, error } = await supabase.from('partnerships').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await ensurePartnerCompanyType(data.company_id);
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const types =
    parsed.data.partner_type !== undefined || parsed.data.partnership_type !== undefined
      ? normalizeTypes(parsed.data)
      : {};

  const { data, error } = await supabase
    .from('partnerships')
    .update({ ...parsed.data, ...types })
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Not found' });

  await ensurePartnerCompanyType(data.company_id);
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('partnerships')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerPartnershipRoutes(api: express.Router) {
  api.use('/partnerships', router);
}
