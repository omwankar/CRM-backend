import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { attachLastActivityStats } from './activities.js';
import { notifySuperAdmins } from '../lib/notifyAdmins.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const leadStatus = z.enum(['new', 'contacted', 'qualified', 'converted', 'lost']);

const createLeadSchema = z.object({
  lead_name: z.string().trim().min(1),
  company_name: z.string().trim().optional().nullable(),
  contact_person: z.string().trim().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  phone: z.string().trim().optional().nullable(),
  source: z.string().trim().optional().nullable(),
  status: leadStatus.optional(),
  estimated_value: z.number().optional().nullable(),
  currency: z.string().trim().optional().nullable(),
  notes: z.string().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
});

const updateLeadSchema = createLeadSchema.partial();

const leadSelect =
  '*, assignee:users!leads_assigned_to_fkey(id, full_name), creator:users!leads_created_by_fkey(id, full_name)';

function isPrivileged(role?: string) {
  return role === 'manager' || role === 'super_admin' || role === 'admin';
}

function ownLeadFilter(userId: string) {
  return `created_by.eq.${userId},assigned_to.eq.${userId}`;
}

async function notifyUser(userId: string, title: string, message: string) {
  await supabase.from('notifications').insert({
    user_id: userId,
    type: 'lead',
    title,
    message,
  });
}

async function recordAssignment(opts: {
  leadId: string;
  fromUserId: string | null;
  toUserId: string | null;
  assignedBy: string;
  leadName: string;
}) {
  const { leadId, fromUserId, toUserId, assignedBy, leadName } = opts;
  if (fromUserId === toUserId) return;

  await supabase.from('lead_assignments').insert({
    lead_id: leadId,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    assigned_by: assignedBy,
  });

  if (toUserId && toUserId !== assignedBy) {
    await notifyUser(
      toUserId,
      'Lead assigned to you',
      `"${leadName}" was assigned to you.`,
    );
  }
}

async function attachConvertedBuyer(
  lead: Record<string, unknown>,
): Promise<
  Record<string, unknown> & {
    converted_buyer: { id: string; buyer_name: string | null; deleted_at: string | null } | null;
    converted_buyer_archived: boolean;
  }
> {
  const buyerId = lead.converted_buyer_id as string | null;
  if (!buyerId) {
    return { ...lead, converted_buyer: null, converted_buyer_archived: false };
  }

  const { data: buyer } = await supabase
    .from('buyers')
    .select('id, buyer_name, deleted_at')
    .eq('id', buyerId)
    .maybeSingle();

  if (!buyer) {
    return { ...lead, converted_buyer: null, converted_buyer_archived: true };
  }

  return {
    ...lead,
    converted_buyer: {
      id: String(buyer.id),
      buyer_name: (buyer.buyer_name as string | null) ?? null,
      deleted_at: (buyer.deleted_at as string | null) ?? null,
    },
    converted_buyer_archived: Boolean(buyer.deleted_at),
  };
}

// GET /api/leads — list (active by default; trash=1 for soft-deleted)
router.get('/', async (req, res) => {
  const { status, search, page = '1', limit = '50', trash } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);
  const showTrash = trash === '1' || trash === 'true';
  const userId = req.user?.id;
  const role = req.user?.role;

  let query = supabase.from('leads').select(leadSelect, { count: 'exact' });

  if (showTrash) query = query.not('deleted_at', 'is', null);
  else query = query.is('deleted_at', null);

  if (!isPrivileged(role) && userId) {
    query = query.or(ownLeadFilter(userId));
  }

  if (status && status !== 'all') query = query.eq('status', String(status));
  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) {
      query = query.or(
        `lead_name.ilike.%${s}%,company_name.ilike.%${s}%,email.ilike.%${s}%,contact_person.ilike.%${s}%`,
      );
    }
  }

  query = query.order(showTrash ? 'deleted_at' : 'created_at', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const enriched = await Promise.all((data || []).map((row) => attachConvertedBuyer(row as Record<string, unknown>)));
  const withActivity = await attachLastActivityStats(
    'lead',
    enriched.map((row) => ({ ...row, id: String(row.id) })),
  );
  res.json({ data: withActivity, total: count || 0, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /api/leads/stats — counts by status (active only)
router.get('/stats', async (req, res) => {
  let query = supabase.from('leads').select('status').is('deleted_at', null);
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!isPrivileged(role) && userId) {
    query = query.or(ownLeadFilter(userId));
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const by: Record<string, number> = {};
  for (const row of data || []) by[row.status] = (by[row.status] || 0) + 1;

  const { count: trashCount } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .not('deleted_at', 'is', null);

  res.json({ total: (data || []).length, by_status: by, trash_count: trashCount || 0 });
});

// GET /api/leads/:id/assignments — reassignment history
router.get('/:id/assignments', async (req, res) => {
  const { data, error } = await supabase
    .from('lead_assignments')
    .select(
      '*, from_user:users!lead_assignments_from_user_id_fkey(id, full_name), to_user:users!lead_assignments_to_user_id_fkey(id, full_name), assigner:users!lead_assignments_assigned_by_fkey(id, full_name)',
    )
    .eq('lead_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) {
    // Fallback without joins if FK names differ
    const fb = await supabase
      .from('lead_assignments')
      .select('*')
      .eq('lead_id', req.params.id)
      .order('created_at', { ascending: false });
    if (fb.error) return res.status(500).json({ error: fb.error.message });
    return res.json({ data: fb.data || [] });
  }

  res.json({ data: data || [] });
});

// GET /api/leads/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .select(leadSelect)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Lead not found' });

  const role = req.user?.role;
  const userId = req.user?.id;
  if (!isPrivileged(role) && userId && data.created_by !== userId && data.assigned_to !== userId) {
    return res.status(403).json({ error: 'You do not have access to this lead' });
  }

  res.json(await attachConvertedBuyer(data as Record<string, unknown>));
});

// POST /api/leads
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('leads')
    .insert({
      ...parsed.data,
      created_by: userId,
      status_changed_at: now,
    })
    .select(leadSelect)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (parsed.data.assigned_to) {
    await recordAssignment({
      leadId: data.id,
      fromUserId: null,
      toUserId: parsed.data.assigned_to,
      assignedBy: userId,
      leadName: data.lead_name,
    });
  }

  res.status(201).json(await attachConvertedBuyer(data as Record<string, unknown>));
});

// PUT /api/leads/:id
router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: existing } = await supabase
    .from('leads')
    .select('id, lead_name, assigned_to, status, deleted_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!existing || existing.deleted_at) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const patch: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.status && parsed.data.status !== existing.status) {
    patch.status_changed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('leads')
    .update(patch)
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .select(leadSelect)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Lead not found' });

  if (parsed.data.assigned_to !== undefined && parsed.data.assigned_to !== existing.assigned_to) {
    await recordAssignment({
      leadId: data.id,
      fromUserId: existing.assigned_to,
      toUserId: parsed.data.assigned_to ?? null,
      assignedBy: userId,
      leadName: data.lead_name,
    });
  }

  const actor = req.user?.full_name || req.user?.email || 'Someone';
  if (parsed.data.status && parsed.data.status !== existing.status) {
    await notifySuperAdmins(
      'lead',
      'Lead status changed',
      `${actor} set "${data.lead_name}" from ${existing.status} to ${parsed.data.status}.`,
    );
  } else if (parsed.data.notes !== undefined) {
    await notifySuperAdmins('lead', 'Lead notes updated', `${actor} updated notes on "${data.lead_name}".`);
  }

  res.json(await attachConvertedBuyer(data as Record<string, unknown>));
});

// POST /api/leads/:id/convert
router.post('/:id/convert', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', req.params.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status === 'converted' && lead.converted_buyer_id) {
    const { data: existingBuyer } = await supabase
      .from('buyers')
      .select('id, buyer_name, deleted_at')
      .eq('id', lead.converted_buyer_id)
      .maybeSingle();

    if (existingBuyer && !existingBuyer.deleted_at) {
      return res.status(400).json({ error: 'Lead is already converted', buyer: existingBuyer });
    }
    // Buyer was soft-deleted / missing — allow re-convert by creating a new buyer
  }

  const { data: buyer, error: buyerErr } = await supabase
    .from('buyers')
    .insert({
      buyer_name: lead.company_name || lead.lead_name,
      contact_person: lead.contact_person || lead.lead_name,
      contact_email: lead.email,
      contact_phone: lead.phone,
      description: lead.notes ? `Converted from lead. ${lead.notes}` : 'Converted from lead.',
    })
    .select()
    .single();

  if (buyerErr) return res.status(500).json({ error: buyerErr.message });

  // Create Opportunity for this deal (Lead → Opportunity)
  const { data: opportunity, error: oppErr } = await supabase
    .from('opportunities')
    .insert({
      buyer_id: buyer.id,
      title: lead.lead_name || buyer.buyer_name,
      stage: 'lead',
      value: lead.estimated_value,
      currency: lead.currency || 'INR',
      owner_id: lead.assigned_to || userId,
      lead_id: lead.id,
      notes: lead.notes,
      created_by: userId,
      updated_by: userId,
    })
    .select()
    .single();

  if (oppErr) {
    // Buyer already created — surface opportunity error but keep convert useful
    console.error('Opportunity create failed on lead convert:', oppErr.message);
  }

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('leads')
    .update({
      status: 'converted',
      converted_buyer_id: buyer.id,
      converted_at: now,
      status_changed_at: now,
    })
    .eq('id', lead.id)
    .select(leadSelect)
    .single();

  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json({
    lead: await attachConvertedBuyer(updated as Record<string, unknown>),
    buyer,
    opportunity: opportunity || null,
  });
});

// DELETE /api/leads/:id — soft delete
router.delete('/:id', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;

  const { data: lead } = await supabase
    .from('leads')
    .select('id, created_by, deleted_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!lead || lead.deleted_at) return res.status(404).json({ error: 'Lead not found' });

  const isPrivileged = role === 'manager' || role === 'super_admin';
  if (!isPrivileged && lead.created_by !== userId) {
    return res.status(403).json({ error: 'You can only delete leads you created' });
  }

  const { error } = await supabase
    .from('leads')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/leads/:id/restore
router.post('/:id/restore', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;
  const isPrivileged = role === 'manager' || role === 'super_admin';

  const { data: lead } = await supabase
    .from('leads')
    .select('id, created_by, deleted_at, lead_name')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!lead || !lead.deleted_at) return res.status(404).json({ error: 'Deleted lead not found' });

  if (!isPrivileged && lead.created_by !== userId) {
    return res.status(403).json({ error: 'You can only restore leads you created' });
  }

  const { data, error } = await supabase
    .from('leads')
    .update({ deleted_at: null })
    .eq('id', req.params.id)
    .select(leadSelect)
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || 'Restore failed' });
  res.json(await attachConvertedBuyer(data as Record<string, unknown>));
});

export function registerLeadRoutes(api: express.Router) {
  api.use('/leads', router);
}
