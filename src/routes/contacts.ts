import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

export const CONTACT_LINK_ENTITY_TYPES = [
  'lead',
  'opportunity',
  'buyer',
  'vendor',
  'company',
  'partnership',
] as const;

const entityType = z.enum(CONTACT_LINK_ENTITY_TYPES);

const linkSchema = z.object({
  entity_type: entityType,
  entity_id: z.string().uuid(),
  role: z.string().trim().optional().nullable(),
});

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
  links: z.array(linkSchema).optional(),
});

type LinkInput = z.infer<typeof linkSchema>;

function legacyFromLinks(links: LinkInput[]) {
  const find = (t: string) => links.find((l) => l.entity_type === t)?.entity_id || null;
  return {
    lead_id: find('lead'),
    buyer_id: find('buyer'),
    vendor_id: find('vendor'),
  };
}

async function replaceLinks(contactId: string, links: LinkInput[]) {
  await supabase.from('contact_links').delete().eq('contact_id', contactId);
  if (!links.length) return [];

  const rows = links.map((l) => ({
    contact_id: contactId,
    entity_type: l.entity_type,
    entity_id: l.entity_id,
    role: l.role?.trim() || null,
  }));

  const { data, error } = await supabase.from('contact_links').insert(rows).select();
  if (error) throw new Error(error.message);
  return data || [];
}

async function resolveLinkLabels(
  links: Array<{
    id?: string;
    contact_id?: string;
    entity_type: string;
    entity_id: string;
    role?: string | null;
    created_at?: string;
  }>,
) {
  if (!links.length) return [];

  const byType: Record<string, string[]> = {};
  for (const l of links) {
    if (!byType[l.entity_type]) byType[l.entity_type] = [];
    byType[l.entity_type].push(l.entity_id);
  }

  const labelMap = new Map<string, string>();

  const load = async (type: string, table: string, nameCol: string) => {
    const ids = byType[type];
    if (!ids?.length) return;
    const { data } = await supabase.from(table).select(`id, ${nameCol}`).in('id', ids);
    for (const row of data || []) {
      labelMap.set(`${type}:${row.id}`, (row as any)[nameCol] || '—');
    }
  };

  await Promise.all([
    load('lead', 'leads', 'lead_name'),
    load('opportunity', 'opportunities', 'title'),
    load('buyer', 'buyers', 'buyer_name'),
    load('vendor', 'vendors', 'vendor_name'),
    load('company', 'companies', 'name'),
    load('partnership', 'partnerships', 'partner_name'),
  ]);

  return links.map((l) => ({
    ...l,
    label: labelMap.get(`${l.entity_type}:${l.entity_id}`) || null,
  }));
}

async function attachLinks(contacts: any[]) {
  if (!contacts.length) return contacts;
  const ids = contacts.map((c) => c.id);
  const { data: allLinks, error } = await supabase
    .from('contact_links')
    .select('*')
    .in('contact_id', ids)
    .order('created_at', { ascending: true });

  if (error) {
    return contacts.map((c) => ({
      ...c,
      links: [
        c.buyer
          ? { entity_type: 'buyer', entity_id: c.buyer.id, label: c.buyer.buyer_name, role: null }
          : null,
        c.vendor
          ? { entity_type: 'vendor', entity_id: c.vendor.id, label: c.vendor.vendor_name, role: null }
          : null,
        c.lead
          ? { entity_type: 'lead', entity_id: c.lead.id, label: c.lead.lead_name, role: null }
          : null,
      ].filter(Boolean),
    }));
  }

  const resolved = await resolveLinkLabels(allLinks || []);
  const byContact = new Map<string, typeof resolved>();
  for (const link of resolved) {
    const cid = String((link as any).contact_id);
    const list = byContact.get(cid) || [];
    list.push(link);
    byContact.set(cid, list);
  }

  return contacts.map((c) => ({
    ...c,
    links: byContact.get(c.id) || [],
  }));
}

router.get('/', async (req, res) => {
  const { search, page = '1', limit = '50', entity_type, entity_id } = req.query;
  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit) || 50);

  let contactIdsFilter: string[] | null = null;
  if (entity_type && entity_id) {
    const { data: linkRows } = await supabase
      .from('contact_links')
      .select('contact_id')
      .eq('entity_type', String(entity_type))
      .eq('entity_id', String(entity_id));
    contactIdsFilter = (linkRows || []).map((r) => r.contact_id);
    if (!contactIdsFilter.length) {
      return res.json({ data: [], total: 0, page: p, limit: l, totalPages: 0 });
    }
  }

  let query = supabase
    .from('contacts')
    .select(
      '*, buyer:buyers(id, buyer_name), vendor:vendors(id, vendor_name), lead:leads(id, lead_name)',
      { count: 'exact' },
    );

  if (contactIdsFilter) query = query.in('id', contactIdsFilter);

  if (search) {
    const s = String(search).replace(/[%_,()]/g, ' ').trim();
    if (s) {
      query = query.or(
        `full_name.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%,phone.ilike.%${s}%`,
      );
    }
  }

  query = query.order('created_at', { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    data: await attachLinks(data || []),
    total: count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('contacts')
    .select('*, buyer:buyers(id, buyer_name), vendor:vendors(id, vendor_name), lead:leads(id, lead_name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Contact not found' });
  const [withLinks] = await attachLinks([data]);
  res.json(withLinks);
});

router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const body = parsed.data;
  const links = body.links || [];
  const legacy = body.links
    ? legacyFromLinks(links)
    : {
        buyer_id: body.buyer_id ?? null,
        vendor_id: body.vendor_id ?? null,
        lead_id: body.lead_id ?? null,
      };

  const { links: _l, buyer_id: _b, vendor_id: _v, lead_id: _lead, ...rest } = body;

  const { data, error } = await supabase
    .from('contacts')
    .insert({ ...rest, ...legacy, created_by: userId })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (body.links !== undefined) {
    try {
      await replaceLinks(data.id, links);
    } catch (e: any) {
      if (!String(e.message || '').toLowerCase().includes('contact_links')) {
        return res.status(500).json({ error: e.message });
      }
    }
  } else if (legacy.buyer_id || legacy.vendor_id || legacy.lead_id) {
    // Seed links from legacy fields when links array omitted
    const seed: LinkInput[] = [];
    if (legacy.buyer_id) seed.push({ entity_type: 'buyer', entity_id: legacy.buyer_id });
    if (legacy.vendor_id) seed.push({ entity_type: 'vendor', entity_id: legacy.vendor_id });
    if (legacy.lead_id) seed.push({ entity_type: 'lead', entity_id: legacy.lead_id });
    try {
      await replaceLinks(data.id, seed);
    } catch {
      /* pre-migration */
    }
  }

  const [enriched] = await attachLinks([data]);
  res.status(201).json(enriched);
});

router.put('/:id', async (req, res) => {
  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const body = parsed.data;
  const patch: Record<string, unknown> = {};
  for (const key of ['full_name', 'email', 'phone', 'designation', 'company', 'notes'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }

  if (body.links !== undefined) {
    Object.assign(patch, legacyFromLinks(body.links));
  } else {
    if (body.buyer_id !== undefined) patch.buyer_id = body.buyer_id;
    if (body.vendor_id !== undefined) patch.vendor_id = body.vendor_id;
    if (body.lead_id !== undefined) patch.lead_id = body.lead_id;
  }

  const { data, error } = await supabase
    .from('contacts')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contact not found' });

  if (body.links !== undefined) {
    try {
      await replaceLinks(data.id, body.links);
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  const [enriched] = await attachLinks([data]);
  res.json(enriched);
});

router.delete('/:id', async (req, res) => {
  const role = req.user?.role;
  const userId = req.user?.id;

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, created_by')
    .eq('id', req.params.id)
    .maybeSingle();
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
