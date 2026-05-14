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
  buyer_name: z.string().min(1),
  contact_person: z.string().optional(),
  contact_email: z.string().optional(),
  contact_phone: z.string().optional(),
  company_type: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
  website: z.string().optional(),
  industry: z.string().optional(),
  description: z.string().optional(),
  buyer_portal_link: z.string().optional(),
  pipeline_stage_id: z.string().uuid().optional(),
  pipeline_notes: z.string().optional(),
  pipeline_value: z.number().optional(),
  expected_close_date: z.string().optional(),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const { search, industry, pipeline_stage_id, page = '1', limit = '20' } = req.query;
  let query = supabase.from('buyers').select('*, pipeline_stages(name, color)', { count: 'exact' }).is('deleted_at', null);
  if (industry) query = query.eq('industry', industry);
  if (pipeline_stage_id) query = query.eq('pipeline_stage_id', pipeline_stage_id);
  if (search) {
    const searchValue = String(search).trim();
    query = query.or(
      `buyer_name.ilike.%${searchValue}%,contact_person.ilike.%${searchValue}%,contact_email.ilike.%${searchValue}%`
    );
  }
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('buyers').select('*, pipeline_stages(name, color)').eq('id', req.params.id).is('deleted_at', null).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('buyers').insert(parsed.data).select('*, pipeline_stages(name, color)').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('buyers').update(parsed.data).eq('id', req.params.id).is('deleted_at', null).select('*, pipeline_stages(name, color)').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('buyers').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerBuyerRoutes(api: express.Router) {
  api.use('/buyers', router);
}
