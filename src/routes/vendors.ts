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
  vendor_name: z.string().min(1),
  vendor_type: z.string().optional(),
  payment_terms: z.string().optional(),
  contact_person: z.string().optional(),
  contact_email: z.string().optional(),
  contact_phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  contract_url: z.string().optional(),
  vendor_portal_link: z.string().optional(),
  company_id: z.string().uuid().optional().nullable(),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const { search, vendor_type, page = '1', limit = '20' } = req.query;
  let query = supabase
    .from('vendors')
    .select('*, company:companies!vendors_company_id_fkey(id, name, company_types)', { count: 'exact' })
    .is('deleted_at', null);
  if (vendor_type) query = query.eq('vendor_type', vendor_type);
  if (search) query = query.ilike('vendor_name', `%${search}%`);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /api/vendors/:id/jobs — before /:id
router.get('/:id/jobs', async (req, res) => {
  const vendorId = req.params.id;

  const { data: links, error: linkErr } = await supabase
    .from('job_vendors')
    .select('id, job_id, notes, added_at')
    .eq('vendor_id', vendorId)
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
    .from('vendors')
    .select('*, company:companies!vendors_company_id_fkey(*)')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });

  let sibling_buyers: Array<{ id: string; buyer_name: string }> = [];
  if (data.company_id) {
    const { data: buyers } = await supabase
      .from('buyers')
      .select('id, buyer_name')
      .eq('company_id', data.company_id)
      .is('deleted_at', null);
    sibling_buyers = buyers || [];
  }

  res.json({
    ...data,
    sibling_buyers,
    also_buyer: sibling_buyers.length > 0,
  });
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('vendors').insert(parsed.data).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (data.company_id) {
    const { data: company } = await supabase
      .from('companies')
      .select('company_types')
      .eq('id', data.company_id)
      .maybeSingle();
    if (company && !(company.company_types || []).includes('vendor')) {
      await supabase
        .from('companies')
        .update({
          company_types: Array.from(new Set([...(company.company_types || []), 'vendor'])),
        })
        .eq('id', data.company_id);
    }
  }

  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('vendors').update(parsed.data).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('vendors').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerVendorRoutes(api: express.Router) {
  api.use('/vendors', router);
}
