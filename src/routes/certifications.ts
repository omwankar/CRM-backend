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
  certification_name: z.string().min(1),
  issuing_authority: z.string().optional(),
  issue_date: z.string(),
  expiry_date: z.string(),
  certificate_number: z.string().optional(),
  credential_id: z.string().optional(),
  status: z.enum(['active', 'expired', 'pending_renewal']).default('active'),
  document_url: z.string().optional(),
  certificate_file: z.string().optional(),
  user_id: z.string().uuid().optional(),
});

const updateSchema = schema.partial();

// GET / — list
router.get('/', async (req, res) => {
  const { search, status, page = '1', limit = '20' } = req.query;
  let query = supabase.from('certifications').select('*, users(full_name, email)', { count: 'exact' }).is('deleted_at', null);

  if (status) query = query.eq('status', status);
  if (search) query = query.ilike('certification_name', `%${search}%`);

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('certifications').select('*, users(full_name, email)').eq('id', req.params.id).is('deleted_at', null).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// POST /
function certPayload(data: z.infer<typeof schema> | z.infer<typeof updateSchema>, userId?: string) {
  const { credential_id, certificate_file, ...rest } = data as z.infer<typeof schema> & {
    credential_id?: string;
    certificate_file?: string;
  };
  return {
    ...rest,
    certificate_number: rest.certificate_number || credential_id || undefined,
    document_url: rest.document_url || certificate_file || undefined,
    user_id: rest.user_id || userId || undefined,
  };
}

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const payload = certPayload(parsed.data, req.user?.id);
  if (!payload.user_id) return res.status(400).json({ error: 'Could not determine owner for this certification.' });
  const { data, error } = await supabase.from('certifications').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const payload = certPayload(parsed.data);
  const { data, error } = await supabase.from('certifications').update(payload).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// DELETE /:id (soft delete)
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('certifications').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerCertificationRoutes(api: express.Router) {
  api.use('/certifications', router);
}
