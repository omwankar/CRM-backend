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

const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  policy_name: z.string().optional(),
  policy_type: z.string().optional(),
  insurance_type: z.string().optional(),
  provider_name: z.string().optional(),
  provider: z.string().optional(),
  policy_number: z.string().optional(),
  coverage_amount: z.preprocess(emptyToUndef, z.coerce.number().optional()),
  premium_amount: z.preprocess(emptyToUndef, z.coerce.number().optional()),
  premium: z.preprocess(emptyToUndef, z.coerce.number().optional()),
  start_date: z.preprocess(emptyToUndef, z.string().optional()),
  expiry_date: z.preprocess(emptyToUndef, z.string().optional()),
  end_date: z.preprocess(emptyToUndef, z.string().optional()),
  renewal_date: z.preprocess(emptyToUndef, z.string().optional()),
  status: z.enum(['active', 'expired', 'pending_renewal']).default('active'),
  document_url: z.string().optional(),
  agent_name: z.string().optional(),
  agent_phone: z.string().optional(),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const { search, status, page = '1', limit = '20' } = req.query;
  let query = supabase.from('insurance').select('*', { count: 'exact' }).is('deleted_at', null);
  if (status) query = query.eq('status', status);
  if (search) query = query.ilike('policy_name', `%${search}%`);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('insurance').select('*').eq('id', req.params.id).is('deleted_at', null).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('insurance').insert(parsed.data).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('insurance').update(parsed.data).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('insurance').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerInsuranceRoutes(api: express.Router) {
  api.use('/insurance', router);
}
