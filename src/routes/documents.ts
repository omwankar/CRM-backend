import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { sharedWriteGuard } from '../middleware/requireRole.js';
import { notifySuperAdmins } from '../lib/notifyAdmins.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

const schema = z.object({
  related_table: z.string().min(1).optional(),
  related_id: z.string().uuid().optional(),
  document_name: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  record_id: z.string().uuid().nullable().optional(),
  file_name: z.string().min(1).optional(),
  document_type: z.enum(['contract', 'agreement', 'certificate', 'policy', 'other']).optional(),
  expiry_date: z.string().nullable().optional(),
  file_url: z.string().min(1),
  file_path: z.string().optional(),
  file_size: z.number().optional(),
  file_type: z.string().optional(),
  uploaded_by: z.string().uuid().optional(),
});

const updateSchema = schema.partial();

function compactPayload(payload: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function missingColumn(message: string) {
  const match = String(message || '').match(/Could not find the '([^']+)' column/i)
    || String(message || '').match(/column (?:[\w.]+\.)?([a-zA-Z0-9_]+) does not exist/i);
  return match?.[1] || null;
}

async function insertDocumentWithFallback(payload: Record<string, unknown>) {
  let attempt = compactPayload(payload);
  for (let i = 0; i < 10; i++) {
    const { data, error } = await supabase.from('documents').insert(attempt).select('*').single();
    if (!error) return { data, error: null as null };

    const col = missingColumn(error.message || '');
    if (col && col in attempt) {
      const { [col]: _removed, ...rest } = attempt;
      attempt = rest;
      continue;
    }

    const m = String(error.message || '').toLowerCase();
    if (m.includes('related_id') && m.includes('null') && 'related_id' in attempt && attempt.related_id == null) {
      attempt = { ...attempt, related_id: attempt.uploaded_by || attempt.record_id || undefined };
      if (attempt.related_id == null) {
        const { related_id: _r, ...rest } = attempt;
        attempt = rest;
      }
      continue;
    }

    return { data: null, error };
  }
  return { data: null, error: { message: 'Could not save the document. Please try again.' } };
}

async function updateDocumentWithFallback(id: string, payload: Record<string, unknown>) {
  let attempt = compactPayload(payload);
  for (let i = 0; i < 10; i++) {
    const { data, error } = await supabase.from('documents').update(attempt).eq('id', id).select('*').single();
    if (!error) return { data, error: null as null };
    const col = missingColumn(error.message || '');
    if (col && col in attempt) {
      const { [col]: _removed, ...rest } = attempt;
      attempt = rest;
      continue;
    }
    return { data: null, error };
  }
  return { data: null, error: { message: 'Not found' } };
}

/** Live documents table may lack created_at; remember whatever order actually works. */
let documentsListOrder: 'created_at' | 'id' | null = 'created_at';

async function listDocuments(req: express.Request) {
  const { related_table, related_id, document_type, module, record_id, page = '1', limit = '20' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  const from = (p - 1) * l;
  const to = p * l - 1;

  const filters: Array<[string, string]> = [];
  if (related_table) filters.push(['related_table', String(related_table)]);
  if (related_id) filters.push(['related_id', String(related_id)]);
  if (module) filters.push(['module', String(module)]);
  if (record_id) filters.push(['record_id', String(record_id)]);
  if (document_type) filters.push(['document_type', String(document_type)]);

  let orderCol: 'created_at' | 'id' | null = documentsListOrder;

  for (let round = 0; round < 8; round++) {
    let query = supabase.from('documents').select('*', { count: 'exact' });
    for (const [col, val] of filters) query = query.eq(col, val);
    query = query.range(from, to);
    if (orderCol) query = query.order(orderCol, { ascending: false });

    const { data, count, error } = await query;
    if (!error) {
      documentsListOrder = orderCol;
      return { data: data || [], count: count || 0, page: p, limit: l };
    }

    const col = missingColumn(error.message || '');
    if (!col) throw error;
    if (col === 'created_at') {
      orderCol = 'id';
      continue;
    }
    if (col === 'id') {
      orderCol = null;
      continue;
    }
    const idx = filters.findIndex(([name]) => name === col);
    if (idx >= 0) {
      filters.splice(idx, 1);
      continue;
    }
    throw error;
  }

  const { data, count, error } = await supabase.from('documents').select('*', { count: 'exact' }).range(from, to);
  if (error) throw error;
  return { data: data || [], count: count || 0, page: p, limit: l };
}

router.get('/', async (req, res) => {
  try {
    const result = await listDocuments(req);
    res.json({
      data: result.data,
      total: result.count,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.count / result.limit) || 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load documents.';
    res.status(500).json({ error: message });
  }
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('documents').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please check the document details and try again.', issues: parsed.error.issues });
  }

  const payload = parsed.data;
  const normalized = compactPayload({
    ...payload,
    related_table: payload.related_table ?? payload.module ?? null,
    related_id: payload.related_id ?? payload.record_id ?? null,
    document_name: payload.document_name ?? payload.file_name ?? null,
    file_name: payload.file_name ?? payload.document_name ?? null,
    module: payload.module ?? payload.related_table ?? null,
    record_id: payload.record_id ?? payload.related_id ?? null,
    uploaded_by: payload.uploaded_by ?? req.user?.id ?? null,
  });

  const { data, error } = await insertDocumentWithFallback(normalized);
  if (error) {
    const m = String(error.message || '').toLowerCase();
    const friendly = m.includes('row-level security')
      ? 'You do not have permission to upload documents.'
      : 'Could not save the document. Please try again.';
    return res.status(500).json({ error: friendly });
  }
  res.status(201).json(data);

  const actor = req.user?.full_name || req.user?.email || 'Someone';
  await notifySuperAdmins(
    'document',
    'Document uploaded',
    `${actor} uploaded "${String(normalized.document_name || 'a document')}".`,
  );
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const payload = parsed.data;
  const normalized = compactPayload({
    ...payload,
    related_table: payload.related_table ?? payload.module,
    related_id: payload.related_id ?? payload.record_id,
    document_name: payload.document_name ?? payload.file_name,
    file_name: payload.file_name ?? payload.document_name,
    module: payload.module ?? payload.related_table,
    record_id: payload.record_id ?? payload.related_id,
  });

  const { data, error } = await updateDocumentWithFallback(req.params.id, normalized);
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const hard = await supabase.from('documents').delete().eq('id', req.params.id).select().single();
  if (hard.error || !hard.data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerDocumentRoutes(api: express.Router) {
  api.use('/documents', router);
}
