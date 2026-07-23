import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { attachLastActivityStats } from './activities.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

export const OPPORTUNITY_STAGES = [
  'lead',
  'contacted',
  'proposal_sent',
  'negotiating',
  'closed_won',
  'closed_lost',
] as const;

const opportunityStage = z.enum(OPPORTUNITY_STAGES);

const createSchema = z.object({
  buyer_id: z.string().uuid(),
  title: z.string().trim().min(1),
  stage: opportunityStage.optional(),
  value: z.number().optional().nullable(),
  currency: z.string().trim().optional().nullable(),
  expected_close_date: z.string().optional().nullable(),
  owner_id: z.string().uuid().optional().nullable(),
  enquiry_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
  lead_id: z.string().uuid().optional().nullable(),
});

const updateSchema = createSchema.partial().omit({ buyer_id: true }).extend({
  buyer_id: z.string().uuid().optional(),
});

const OPEN_STAGES = ['lead', 'contacted', 'proposal_sent', 'negotiating'];

function isPrivileged(role?: string) {
  return role === 'manager' || role === 'super_admin';
}

async function computeBuyerOpenPipeline(buyerId: string) {
  const { data } = await supabase
    .from('opportunities')
    .select('value, currency, stage')
    .eq('buyer_id', buyerId)
    .is('deleted_at', null)
    .in('stage', OPEN_STAGES);

  const byCurrency: Record<string, number> = {};
  for (const row of data || []) {
    const cur = row.currency || 'INR';
    byCurrency[cur] = (byCurrency[cur] || 0) + Number(row.value || 0);
  }
  return {
    open_count: (data || []).length,
    open_pipeline_by_currency: byCurrency,
    open_pipeline_value: Object.values(byCurrency).reduce((a, b) => a + b, 0),
  };
}

// GET /api/opportunities
router.get('/', async (req, res) => {
  const { stage, buyer_id, search, page = '1', limit = '50', trash } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);
  const showTrash = trash === '1' || trash === 'true';
  const role = req.user?.role;
  const userId = req.user?.id;

  let query = supabase
    .from('opportunities')
    .select(
      '*, buyer:buyers!opportunities_buyer_id_fkey(id, buyer_name), owner:users!opportunities_owner_id_fkey(id, full_name)',
      { count: 'exact' },
    );

  if (showTrash) query = query.not('deleted_at', 'is', null);
  else query = query.is('deleted_at', null);

  if (stage && stage !== 'all') query = query.eq('stage', String(stage));
  if (buyer_id) query = query.eq('buyer_id', String(buyer_id));
  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) query = query.ilike('title', `%${s}%`);
  }

  if (role === 'user' && userId) {
    query = query.or(`created_by.eq.${userId},owner_id.eq.${userId}`);
  }

  query = query.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) {
    let fb = supabase.from('opportunities').select('*', { count: 'exact' });
    if (showTrash) fb = fb.not('deleted_at', 'is', null);
    else fb = fb.is('deleted_at', null);
    if (stage && stage !== 'all') fb = fb.eq('stage', String(stage));
    if (buyer_id) fb = fb.eq('buyer_id', String(buyer_id));
    fb = fb.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);
    const r = await fb;
    if (r.error) return res.status(500).json({ error: r.error.message });
    return res.json({
      data: await attachLastActivityStats('opportunity', r.data || []),
      total: r.count || 0,
      page: p,
      limit: l,
      totalPages: Math.ceil((r.count || 0) / l),
    });
  }

  res.json({
    data: await attachLastActivityStats('opportunity', data || []),
    total: count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

// GET /api/opportunities/stats
router.get('/stats', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;
  let query = supabase.from('opportunities').select('stage, value, currency').is('deleted_at', null);
  if (role === 'user' && userId) {
    query = query.or(`created_by.eq.${userId},owner_id.eq.${userId}`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const by_stage: Record<string, number> = {};
  let open_value = 0;
  for (const row of data || []) {
    by_stage[row.stage] = (by_stage[row.stage] || 0) + 1;
    if (OPEN_STAGES.includes(row.stage)) open_value += Number(row.value || 0);
  }
  res.json({ total: (data || []).length, by_stage, open_pipeline_value: open_value });
});

// GET /api/opportunities/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Opportunity not found' });

  const role = req.user?.role;
  const userId = req.user?.id;
  if (role === 'user' && userId && data.created_by !== userId && data.owner_id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const [{ data: buyer }, { data: owner }, { data: enquiries }, { data: quotations }] = await Promise.all([
    supabase.from('buyers').select('id, buyer_name, contact_email, deleted_at').eq('id', data.buyer_id).maybeSingle(),
    data.owner_id
      ? supabase.from('users').select('id, full_name, email').eq('id', data.owner_id).maybeSingle()
      : Promise.resolve({ data: null } as any),
    supabase
      .from('enquiries')
      .select('id, enquiry_number, title, stage, created_at')
      .eq('opportunity_id', data.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('quotations')
      .select('id, quotation_number, status, quote_sent_at, created_at')
      .eq('opportunity_id', data.id)
      .order('created_at', { ascending: false }),
  ]);

  res.json({
    ...data,
    buyer: buyer || null,
    owner: owner || null,
    enquiries: enquiries || [],
    quotations: quotations || [],
  });
});

// POST /api/opportunities
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: buyer } = await supabase
    .from('buyers')
    .select('id')
    .eq('id', parsed.data.buyer_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!buyer) return res.status(400).json({ error: 'Buyer not found or archived' });

  const { data, error } = await supabase
    .from('opportunities')
    .insert({
      ...parsed.data,
      owner_id: parsed.data.owner_id || userId,
      created_by: userId,
      updated_by: userId,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (parsed.data.enquiry_id) {
    await supabase
      .from('enquiries')
      .update({ opportunity_id: data.id, buyer_id: parsed.data.buyer_id, updated_by: userId })
      .eq('id', parsed.data.enquiry_id);
  }

  res.status(201).json(data);
});

// PUT /api/opportunities/:id
router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: existing } = await supabase
    .from('opportunities')
    .select('id, created_by, owner_id, deleted_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Opportunity not found' });

  if (!isPrivileged(req.user?.role) && existing.created_by !== userId && existing.owner_id !== userId) {
    return res.status(403).json({ error: 'You can only edit opportunities you own or created' });
  }

  const { data, error } = await supabase
    .from('opportunities')
    .update({ ...parsed.data, updated_by: userId })
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || 'Update failed' });
  res.json(data);
});

// DELETE soft
router.delete('/:id', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  const { data: existing } = await supabase
    .from('opportunities')
    .select('id, created_by, deleted_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Opportunity not found' });
  if (!isPrivileged(role) && existing.created_by !== userId) {
    return res.status(403).json({ error: 'You can only delete opportunities you created' });
  }

  const { error } = await supabase
    .from('opportunities')
    .update({ deleted_at: new Date().toISOString(), updated_by: userId })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/:id/restore', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  const { data: existing } = await supabase
    .from('opportunities')
    .select('id, created_by, deleted_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing?.deleted_at) return res.status(404).json({ error: 'Deleted opportunity not found' });
  if (!isPrivileged(role) && existing.created_by !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { data, error } = await supabase
    .from('opportunities')
    .update({ deleted_at: null, updated_by: userId })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export { computeBuyerOpenPipeline };

export function registerOpportunityRoutes(api: express.Router) {
  api.use('/opportunities', router);
}
