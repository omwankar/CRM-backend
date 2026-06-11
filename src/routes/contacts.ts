import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Any authenticated user can manage contacts.
router.use(authMiddleware);
router.use(auditLog);

const contactSchema = z.object({
  full_name: z.string().trim().min(1),
  email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  phone: z.string().trim().optional().nullable(),
  designation: z.string().trim().optional().nullable(),
  company: z.string().trim().optional().nullable(),
  buyer_id: z.string().uuid().optional().nullable(),
  vendor_id: z.string().uuid().optional().nullable(),
  lead_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// GET /api/contacts — list with search
router.get('/', async (req, res) => {
  const { search, page = '1', limit = '50' } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);

  let query = supabase
    .from('contacts')
    .select('*, buyer:buyers(id, buyer_name), vendor:vendors(id, vendor_name), lead:leads(id, lead_name)', { count: 'exact' });

  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) {
      query = query.or(`full_name.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%,phone.ilike.%${s}%`);
    }
  }

  query = query.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [], total: count || 0, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('contacts')
    .insert({ ...parsed.data, created_by: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/contacts/:id
router.put('/:id', async (req, res) => {
  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase
    .from('contacts')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contact not found' });
  res.json(data);
});

// DELETE /api/contacts/:id — manager/super_admin, or the creator
router.delete('/:id', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;

  const { data: contact } = await supabase.from('contacts').select('id, created_by').eq('id', req.params.id).maybeSingle();
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const isPrivileged = role === 'manager' || role === 'super_admin';
  if (!isPrivileged && contact.created_by !== userId) {
    return res.status(403).json({ error: 'You can only delete contacts you created' });
  }

  const { error } = await supabase.from('contacts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerContactRoutes(api: express.Router) {
  api.use('/contacts', router);
}
