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
  alert_type: z.enum(['expiry', 'renewal_due', 'system', 'info']),
  related_table: z.string().optional(),
  related_id: z.string().uuid().optional(),
  title: z.string().min(1),
  message: z.string().optional(),
  days_before_expiry: z.number().optional(),
  is_dismissed: z.boolean().default(false),
});

const updateSchema = schema.partial();

router.get('/', async (req, res) => {
  const { alert_type, is_dismissed, page = '1', limit = '20' } = req.query;
  let query = supabase.from('alerts').select('*', { count: 'exact' });
  if (alert_type) query = query.eq('alert_type', alert_type);
  if (is_dismissed !== undefined) query = query.eq('is_dismissed', is_dismissed === 'true');
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

type ExpiryAlert = {
  id: string;
  type: 'certification' | 'membership' | 'insurance';
  name: string;
  expiry_date: string;
  days_until_expiry: number;
  status: 'expired' | 'expiring_soon';
  href: string;
};

function daysUntil(dateStr: string, today: Date): number | null {
  if (!dateStr) return null;
  const expiry = new Date(dateStr);
  if (Number.isNaN(expiry.getTime())) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

/** Computed expiry alerts from certifications / memberships / insurance (not the alerts table). */
router.get('/expiring', async (req, res) => {
  const certDays = Math.max(1, Number(req.query.cert_days) || 30);
  const memDays = Math.max(1, Number(req.query.membership_days) || 30);
  const insDays = Math.max(1, Number(req.query.insurance_days) || 30);
  const today = new Date();
  const alerts: ExpiryAlert[] = [];

  const [{ data: certs }, { data: memberships }, { data: insurances }] = await Promise.all([
    supabase
      .from('certifications')
      .select('id, certification_name, expiry_date')
      .is('deleted_at', null),
    supabase
      .from('memberships')
      .select('id, organization_name, renewal_date')
      .is('deleted_at', null),
    supabase
      .from('insurance')
      .select('id, policy_name, provider, provider_name, insurance_type, policy_type, end_date, expiry_date')
      .is('deleted_at', null),
  ]);

  for (const cert of certs || []) {
    const days = daysUntil(cert.expiry_date, today);
    if (days == null || days > certDays) continue;
    alerts.push({
      id: cert.id,
      type: 'certification',
      name: cert.certification_name || 'Certification',
      expiry_date: cert.expiry_date,
      days_until_expiry: days,
      status: days < 0 ? 'expired' : 'expiring_soon',
      href: `/dashboard/certifications/${cert.id}`,
    });
  }

  for (const mem of memberships || []) {
    const days = daysUntil(mem.renewal_date, today);
    if (days == null || days > memDays) continue;
    alerts.push({
      id: mem.id,
      type: 'membership',
      name: mem.organization_name || 'Membership',
      expiry_date: mem.renewal_date,
      days_until_expiry: days,
      status: days < 0 ? 'expired' : 'expiring_soon',
      href: `/dashboard/memberships/${mem.id}`,
    });
  }

  for (const ins of insurances || []) {
    const dateStr = ins.expiry_date || ins.end_date;
    const days = daysUntil(dateStr, today);
    if (days == null || days > insDays) continue;
    const label =
      ins.policy_name ||
      [ins.provider || ins.provider_name, ins.insurance_type || ins.policy_type]
        .filter(Boolean)
        .join(' · ') ||
      'Insurance policy';
    alerts.push({
      id: ins.id,
      type: 'insurance',
      name: label,
      expiry_date: dateStr,
      days_until_expiry: days,
      status: days < 0 ? 'expired' : 'expiring_soon',
      href: `/dashboard/insurance/${ins.id}`,
    });
  }

  alerts.sort((a, b) => a.days_until_expiry - b.days_until_expiry);
  res.json({
    data: alerts,
    total: alerts.length,
    thresholds: { certification: certDays, membership: memDays, insurance: insDays },
  });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('alerts').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('alerts').insert(parsed.data).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  const { data, error } = await supabase.from('alerts').update(parsed.data).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.from('alerts').delete().eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

export function registerAlertRoutes(api: express.Router) {
  api.use('/alerts', router);
}
