import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const schema = z.object({
  related_table: z.string().min(1).optional(),
  related_id: z.string().uuid().optional(),
  document_name: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  record_id: z.string().uuid().nullable().optional(),
  file_name: z.string().min(1).optional(),
  document_type: z.enum(['contract', 'agreement', 'certificate', 'policy', 'other']).optional(),
  file_url: z.string().min(1),
  file_path: z.string().optional(),
  file_size: z.number().optional(),
  file_type: z.string().optional(),
  uploaded_by: z.string().uuid().optional(),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const { related_table, related_id, document_type, module, record_id, page = '1', limit = '20' } = req.query;
  let query = supabase.from('documents').select('*', { count: 'exact' });
  if (related_table) query = query.eq('related_table', related_table);
  if (related_id) query = query.eq('related_id', related_id);
  if (module) query = query.eq('module', module);
  if (record_id) query = query.eq('record_id', record_id);
  if (document_type) query = query.eq('document_type', document_type);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('documents').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const payload = parsed.data;
  const normalized = {
    ...payload,
    related_table: payload.related_table ?? payload.module ?? null,
    related_id: payload.related_id ?? payload.record_id ?? null,
    document_name: payload.document_name ?? payload.file_name ?? null,
    file_name: payload.file_name ?? payload.document_name ?? null,
    module: payload.module ?? payload.related_table ?? null,
    record_id: payload.record_id ?? payload.related_id ?? null,
  };

  const { data, error } = await supabase.from('documents').insert(normalized).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const payload = parsed.data;
  const normalized = {
    ...payload,
    related_table: payload.related_table ?? payload.module,
    related_id: payload.related_id ?? payload.record_id,
    document_name: payload.document_name ?? payload.file_name,
    file_name: payload.file_name ?? payload.document_name,
    module: payload.module ?? payload.related_table,
    record_id: payload.record_id ?? payload.related_id,
  };

  const { data, error } = await supabase.from('documents').update(normalized).eq('id', req.params.id).select('*').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('documents').delete().eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerDocumentRoutes(api: express.Router) {
  api.use('/documents', router);
}
