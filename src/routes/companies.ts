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

export const COMPANY_TYPES = ['customer', 'vendor', 'partner', 'prospect'] as const;

const companyType = z.enum(COMPANY_TYPES);

const createSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  postal_code: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  company_types: z.array(companyType).min(1).optional(),
  notes: z.string().optional().nullable(),
});

const updateSchema = createSchema.partial();

function normalizeTypes(types?: string[] | null) {
  const unique = Array.from(new Set(types && types.length ? types : ['prospect']));
  return unique;
}

async function linkedRoles(companyId: string) {
  const [{ data: buyers }, { data: vendors }, { data: partnerships }] = await Promise.all([
    supabase
      .from('buyers')
      .select('id, buyer_name, contact_email, industry, created_at')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase
      .from('vendors')
      .select('id, vendor_name, contact_email, vendor_type, created_at')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase
      .from('partnerships')
      .select('id, partner_name, partner_company_name, partner_type, partnership_type, created_at')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
  ]);
  return {
    buyers: buyers || [],
    vendors: vendors || [],
    partnerships: partnerships || [],
    also_buyer: (buyers || []).length > 0,
    also_vendor: (vendors || []).length > 0,
    also_partner: (partnerships || []).length > 0,
  };
}

// GET /api/companies
router.get('/', async (req, res) => {
  const { search, type, page = '1', limit = '50', trash } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);
  const showTrash = trash === '1' || trash === 'true';

  let query = supabase.from('companies').select('*', { count: 'exact' });

  if (showTrash) query = query.not('deleted_at', 'is', null);
  else query = query.is('deleted_at', null);

  if (type && type !== 'all') {
    query = query.contains('company_types', [String(type)]);
  }

  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) {
      query = query.or(
        `name.ilike.%${s}%,industry.ilike.%${s}%,city.ilike.%${s}%,website.ilike.%${s}%`,
      );
    }
  }

  query = query.order('name', { ascending: true }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    data: data || [],
    total: count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

// GET /api/companies/stats
router.get('/stats', async (_req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('company_types')
    .is('deleted_at', null);
  if (error) return res.status(500).json({ error: error.message });

  const by_type: Record<string, number> = {};
  for (const t of COMPANY_TYPES) by_type[t] = 0;
  for (const row of data || []) {
    for (const t of row.company_types || []) {
      by_type[t] = (by_type[t] || 0) + 1;
    }
  }
  res.json({ total: (data || []).length, by_type });
});

// GET /api/companies/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });

  const links = await linkedRoles(data.id);
  res.json({ ...data, ...links });
});

// POST /api/companies
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const payload = {
    ...parsed.data,
    company_types: normalizeTypes(parsed.data.company_types),
    created_by: req.user?.id || null,
    updated_by: req.user?.id || null,
  };

  const { data, error } = await supabase.from('companies').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/companies/:id
router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const payload: Record<string, unknown> = {
    ...parsed.data,
    updated_by: req.user?.id || null,
  };
  if (parsed.data.company_types) {
    payload.company_types = normalizeTypes(parsed.data.company_types);
  }

  const { data, error } = await supabase
    .from('companies')
    .update(payload)
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: error?.message || 'Not found' });

  const links = await linkedRoles(data.id);
  res.json({ ...data, ...links });
});

// DELETE soft
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .update({ deleted_at: new Date().toISOString(), updated_by: req.user?.id || null })
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

router.post('/:id/restore', async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .update({ deleted_at: null, updated_by: req.user?.id || null })
    .eq('id', req.params.id)
    .not('deleted_at', 'is', null)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

export function registerCompanyRoutes(api: express.Router) {
  api.use('/companies', router);
}
