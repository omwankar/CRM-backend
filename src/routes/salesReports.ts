import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { requireHrAccess } from '../middleware/requireRole.js';
import { attachLastActivityStats } from './activities.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);

const OPEN_STAGES = ['lead', 'contacted', 'proposal_sent', 'negotiating'] as const;
const STAGE_ORDER = [
  'lead',
  'contacted',
  'proposal_sent',
  'negotiating',
  'closed_won',
  'closed_lost',
] as const;

/** Forecast probability by stage (negotiating = 70% as product default) */
const STAGE_WEIGHT: Record<string, number> = {
  lead: 0.1,
  contacted: 0.25,
  proposal_sent: 0.5,
  negotiating: 0.7,
  closed_won: 1,
  closed_lost: 0,
};

const LEAD_SOURCES = ['website', 'referral', 'cold_call', 'event', 'other'] as const;

function isManagerRole(role?: string) {
  return role === 'manager' || role === 'super_admin' || role === 'admin';
}

function dateRange(req: express.Request) {
  const from =
    (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  return {
    from,
    to,
    fromIso: `${from}T00:00:00.000Z`,
    toIso: `${to}T23:59:59.999Z`,
  };
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

async function loadUserNames(ids: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return {};
  const { data } = await supabase.from('users').select('id, full_name, email').in('id', unique);
  return (data || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
    acc[u.id] = u.full_name || u.email || 'User';
    return acc;
  }, {});
}

// ------------------------------------------------------------
// GET /api/reports/sales/pipeline — Opportunities by stage + value
// ------------------------------------------------------------
router.get('/pipeline', requireHrAccess, async (_req, res) => {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, stage, value, currency, owner_id')
    .is('deleted_at', null)
    .limit(5000);

  if (error) return res.status(500).json({ error: error.message });

  const byStage: Record<
    string,
    { stage: string; count: number; total_value: number }
  > = {};
  for (const s of STAGE_ORDER) {
    byStage[s] = { stage: s, count: 0, total_value: 0 };
  }

  let openCount = 0;
  let openValue = 0;
  let wonCount = 0;
  let wonValue = 0;

  for (const row of data || []) {
    const stage = STAGE_ORDER.includes(row.stage as (typeof STAGE_ORDER)[number])
      ? row.stage
      : 'lead';
    if (!byStage[stage]) byStage[stage] = { stage, count: 0, total_value: 0 };
    const v = Number(row.value) || 0;
    byStage[stage].count += 1;
    byStage[stage].total_value += v;
    if (OPEN_STAGES.includes(stage as (typeof OPEN_STAGES)[number])) {
      openCount += 1;
      openValue += v;
    }
    if (stage === 'closed_won') {
      wonCount += 1;
      wonValue += v;
    }
  }

  res.json({
    stages: STAGE_ORDER.map((s) => ({
      ...byStage[s],
      total_value: Math.round(byStage[s].total_value * 100) / 100,
    })),
    summary: {
      open_count: openCount,
      open_value: Math.round(openValue * 100) / 100,
      won_count: wonCount,
      won_value: Math.round(wonValue * 100) / 100,
      total_count: (data || []).length,
    },
  });
});

// ------------------------------------------------------------
// GET /api/reports/sales/funnel?from=&to=&source=
// Lead → Opportunity → Quotation → Won
// ------------------------------------------------------------
router.get('/funnel', requireHrAccess, async (req, res) => {
  const { from, to, fromIso, toIso } = dateRange(req);
  const sourceFilter = (req.query.source as string) || 'all';

  let leadsQ = supabase
    .from('leads')
    .select('id, source, status, created_at')
    .is('deleted_at', null)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .limit(5000);

  if (sourceFilter !== 'all' && LEAD_SOURCES.includes(sourceFilter as (typeof LEAD_SOURCES)[number])) {
    leadsQ = leadsQ.eq('source', sourceFilter);
  }

  const [leadsRes, oppsRes, quotesRes] = await Promise.all([
    leadsQ,
    supabase
      .from('opportunities')
      .select('id, lead_id, stage, created_at, value')
      .is('deleted_at', null)
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
      .limit(5000),
    supabase
      .from('quotations')
      .select('id, opportunity_id, status, enquiry_stage, created_at, quote_sent_at')
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
      .limit(5000),
  ]);

  if (leadsRes.error) return res.status(500).json({ error: leadsRes.error.message });
  if (oppsRes.error) return res.status(500).json({ error: oppsRes.error.message });
  if (quotesRes.error) return res.status(500).json({ error: quotesRes.error.message });

  let leads = leadsRes.data || [];
  let opps = oppsRes.data || [];
  let quotes = quotesRes.data || [];

  // When slicing by source, narrow opportunities/quotations via lead linkage
  if (sourceFilter !== 'all') {
    const leadIds = new Set(leads.map((l) => l.id));
    opps = opps.filter((o) => o.lead_id && leadIds.has(o.lead_id));
    const oppIds = new Set(opps.map((o) => o.id));
    quotes = quotes.filter((q) => q.opportunity_id && oppIds.has(q.opportunity_id));
  }

  const leadCount = leads.length;
  const oppCount = opps.length;
  const quoteCount = quotes.length;
  const wonOpps = opps.filter((o) => o.stage === 'closed_won').length;
  const wonQuoteOnly = quotes.filter(
    (q) =>
      (q.status === 'approved' || q.enquiry_stage === 'won_closed') &&
      (!q.opportunity_id || !opps.some((o) => o.id === q.opportunity_id && o.stage === 'closed_won')),
  ).length;
  const won = wonOpps + wonQuoteOnly;

  // By source breakdown (overall funnel, ignore source filter for this chart)
  const bySource: Array<{
    source: string;
    leads: number;
    opportunities: number;
    quotations: number;
    won: number;
    lead_to_opp_pct: number | null;
    opp_to_quote_pct: number | null;
    quote_to_won_pct: number | null;
  }> = [];

  if (sourceFilter === 'all') {
    const allLeads = leads;
    for (const src of LEAD_SOURCES) {
      const srcLeads = allLeads.filter((l) => (l.source || 'other') === src);
      const srcLeadIds = new Set(srcLeads.map((l) => l.id));
      const srcOpps = opps.filter((o) => o.lead_id && srcLeadIds.has(o.lead_id));
      const srcOppIds = new Set(srcOpps.map((o) => o.id));
      const srcQuotes = quotes.filter((q) => q.opportunity_id && srcOppIds.has(q.opportunity_id));
      const srcWon =
        srcOpps.filter((o) => o.stage === 'closed_won').length +
        srcQuotes.filter(
          (q) =>
            (q.status === 'approved' || q.enquiry_stage === 'won_closed') &&
            (!q.opportunity_id ||
              !srcOpps.some((o) => o.id === q.opportunity_id && o.stage === 'closed_won')),
        ).length;
      bySource.push({
        source: src,
        leads: srcLeads.length,
        opportunities: srcOpps.length,
        quotations: srcQuotes.length,
        won: srcWon,
        lead_to_opp_pct: pct(srcOpps.length, srcLeads.length),
        opp_to_quote_pct: pct(srcQuotes.length, srcOpps.length),
        quote_to_won_pct: pct(srcWon, srcQuotes.length),
      });
    }
  }

  res.json({
    from,
    to,
    source: sourceFilter,
    steps: [
      { key: 'leads', label: 'Leads', count: leadCount },
      { key: 'opportunities', label: 'Opportunities', count: oppCount, conversion_from_prev_pct: pct(oppCount, leadCount) },
      { key: 'quotations', label: 'Quotations', count: quoteCount, conversion_from_prev_pct: pct(quoteCount, oppCount) },
      { key: 'won', label: 'Won', count: won, conversion_from_prev_pct: pct(won, quoteCount) },
    ],
    overall_lead_to_won_pct: pct(won, leadCount),
    by_source: bySource,
  });
});

// ------------------------------------------------------------
// GET /api/reports/sales/rep-performance?from=&to=
// Manager: all reps; user: self only
// ------------------------------------------------------------
router.get('/rep-performance', async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const managerView = isManagerRole(role);
  const { from, to, fromIso, toIso } = dateRange(req);

  let oppQ = supabase
    .from('opportunities')
    .select('id, owner_id, stage, value, created_at, updated_at')
    .is('deleted_at', null)
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .limit(5000);

  if (!managerView) {
    oppQ = oppQ.eq('owner_id', userId);
  }

  const [oppsRes, actsRes] = await Promise.all([
    oppQ,
    managerView
      ? supabase
          .from('activities')
          .select('id, created_by, type, activity_date')
          .gte('activity_date', fromIso)
          .lte('activity_date', toIso)
          .limit(5000)
      : supabase
          .from('activities')
          .select('id, created_by, type, activity_date')
          .eq('created_by', userId)
          .gte('activity_date', fromIso)
          .lte('activity_date', toIso)
          .limit(5000),
  ]);

  if (oppsRes.error) return res.status(500).json({ error: oppsRes.error.message });
  if (actsRes.error) return res.status(500).json({ error: actsRes.error.message });

  const opps = oppsRes.data || [];
  const acts = actsRes.data || [];

  type Acc = {
    owner_id: string;
    won: number;
    lost: number;
    open: number;
    won_value: number;
    deal_sizes: number[];
    close_days: number[];
    activity_count: number;
  };

  const map = new Map<string, Acc>();

  function ensure(id: string): Acc {
    if (!map.has(id)) {
      map.set(id, {
        owner_id: id,
        won: 0,
        lost: 0,
        open: 0,
        won_value: 0,
        deal_sizes: [],
        close_days: [],
        activity_count: 0,
      });
    }
    return map.get(id)!;
  }

  for (const o of opps) {
    const oid = o.owner_id || 'unassigned';
    const a = ensure(oid);
    const v = Number(o.value) || 0;
    if (o.stage === 'closed_won') {
      a.won += 1;
      a.won_value += v;
      a.deal_sizes.push(v);
      // No closed_at column yet — use updated_at when stage is closed
      a.close_days.push(daysBetween(o.created_at, o.updated_at));
    } else if (o.stage === 'closed_lost') {
      a.lost += 1;
      a.close_days.push(daysBetween(o.created_at, o.updated_at));
    } else {
      a.open += 1;
    }
  }

  for (const act of acts) {
    if (!act.created_by) continue;
    ensure(act.created_by).activity_count += 1;
  }

  // Ensure requesting user appears even with zero rows
  if (!managerView) ensure(userId);

  const names = await loadUserNames(
    Array.from(map.keys()).filter((id) => id !== 'unassigned'),
  );
  names.unassigned = 'Unassigned';

  const reps = Array.from(map.values())
    .map((a) => ({
      owner_id: a.owner_id,
      name: names[a.owner_id] || 'User',
      won: a.won,
      lost: a.lost,
      open: a.open,
      won_value: Math.round(a.won_value * 100) / 100,
      avg_deal_size: avg(a.deal_sizes),
      avg_days_to_close: avg(a.close_days),
      activity_count: a.activity_count,
    }))
    .sort((x, y) => y.won_value - x.won_value || y.won - x.won);

  res.json({
    from,
    to,
    manager_view: managerView,
    reps,
  });
});

// ------------------------------------------------------------
// GET /api/reports/sales/stale?days=14
// Open opportunities / active enquiries with no activity in N days
// ------------------------------------------------------------
router.get('/stale', requireHrAccess, async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));

  const [oppsRes, enqsRes] = await Promise.all([
    supabase
      .from('opportunities')
      .select('id, title, stage, value, currency, owner_id, expected_close_date, created_at')
      .is('deleted_at', null)
      .in('stage', [...OPEN_STAGES])
      .limit(2000),
    supabase
      .from('enquiries')
      .select('id, enquiry_number, title, stage, owner_id, deadline, created_at')
      .not('stage', 'in', '(won_closed,lost_closed)')
      .limit(2000),
  ]);

  if (oppsRes.error) return res.status(500).json({ error: oppsRes.error.message });
  if (enqsRes.error) return res.status(500).json({ error: enqsRes.error.message });

  const opps = await attachLastActivityStats('opportunity', oppsRes.data || []);
  const enqs = await attachLastActivityStats('enquiry', enqsRes.data || []);

  const isStale = (d: number | null) => d === null || d >= days;

  const staleOpps = opps.filter((o) => isStale(o.days_since_last_activity));
  const staleEnqs = enqs.filter((e) => isStale(e.days_since_last_activity));

  const names = await loadUserNames([
    ...staleOpps.map((o) => o.owner_id).filter(Boolean) as string[],
    ...staleEnqs.map((e) => e.owner_id).filter(Boolean) as string[],
  ]);

  res.json({
    days,
    opportunities: staleOpps
      .map((o) => ({
        id: o.id,
        title: o.title,
        stage: o.stage,
        value: o.value,
        currency: o.currency,
        owner_id: o.owner_id,
        owner_name: o.owner_id ? names[o.owner_id] || null : null,
        expected_close_date: o.expected_close_date,
        last_activity_at: o.last_activity_at,
        days_since_last_activity: o.days_since_last_activity,
      }))
      .sort((a, b) => (b.days_since_last_activity ?? 9999) - (a.days_since_last_activity ?? 9999)),
    enquiries: staleEnqs
      .map((e) => ({
        id: e.id,
        enquiry_number: e.enquiry_number,
        title: e.title,
        stage: e.stage,
        owner_id: e.owner_id,
        owner_name: e.owner_id ? names[e.owner_id] || null : null,
        deadline: e.deadline,
        last_activity_at: e.last_activity_at,
        days_since_last_activity: e.days_since_last_activity,
      }))
      .sort((a, b) => (b.days_since_last_activity ?? 9999) - (a.days_since_last_activity ?? 9999)),
    summary: {
      stale_opportunities: staleOpps.length,
      stale_enquiries: staleEnqs.length,
    },
  });
});

// ------------------------------------------------------------
// GET /api/reports/sales/quotation-win-rate?from=&to=
// ------------------------------------------------------------
router.get('/quotation-win-rate', requireHrAccess, async (req, res) => {
  const { from, to, fromIso, toIso } = dateRange(req);

  const { data, error } = await supabase
    .from('quotations')
    .select(
      'id, status, enquiry_stage, quote_sent_at, clarusto_quote_sent_at, created_at, revised_at',
    )
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .limit(5000);

  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const sent = rows.filter((q) => q.quote_sent_at || q.clarusto_quote_sent_at);
  const won = rows.filter((q) => q.status === 'approved' || q.enquiry_stage === 'won_closed');
  const lost = rows.filter((q) => q.status === 'rejected' || q.enquiry_stage === 'lost_closed');
  const cancelled = rows.filter((q) => q.status === 'cancelled');

  const ids = rows.map((q) => q.id);
  let revisionCounts: number[] = [];
  if (ids.length) {
    const { data: revs, error: rErr } = await supabase
      .from('quotation_revisions')
      .select('quotation_id, revision_number')
      .in('quotation_id', ids)
      .limit(10000);

    if (!rErr && revs) {
      const maxByQ = new Map<string, number>();
      for (const r of revs) {
        const n = Number(r.revision_number) || 0;
        maxByQ.set(r.quotation_id, Math.max(maxByQ.get(r.quotation_id) || 0, n));
      }
      // For closed quotes, average revision count (0 if none)
      const closedIds = [...won, ...lost].map((q) => q.id);
      revisionCounts = closedIds.map((id) => maxByQ.get(id) || 0);
    }
  }

  // Fallback: revised_at present counts as at least 1 revision
  if (!revisionCounts.length) {
    revisionCounts = [...won, ...lost].map((q) => (q.revised_at ? 1 : 0));
  }

  res.json({
    from,
    to,
    total: rows.length,
    sent: sent.length,
    won: won.length,
    lost: lost.length,
    cancelled: cancelled.length,
    win_rate_pct: pct(won.length, sent.length || rows.length),
    loss_rate_pct: pct(lost.length, sent.length || rows.length),
    avg_revisions_before_close: avg(revisionCounts),
  });
});

// ------------------------------------------------------------
// GET /api/reports/sales/forecast
// Weighted pipeline by expected_close month
// ------------------------------------------------------------
router.get('/forecast', requireHrAccess, async (_req, res) => {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, title, stage, value, currency, expected_close_date, owner_id')
    .is('deleted_at', null)
    .in('stage', [...OPEN_STAGES])
    .limit(5000);

  if (error) return res.status(500).json({ error: error.message });

  const months: Record<
    string,
    { month: string; deals: number; pipeline_value: number; weighted_value: number }
  > = {};

  let totalPipeline = 0;
  let totalWeighted = 0;

  for (const o of data || []) {
    const month = o.expected_close_date
      ? String(o.expected_close_date).slice(0, 7)
      : 'unscheduled';
    if (!months[month]) {
      months[month] = { month, deals: 0, pipeline_value: 0, weighted_value: 0 };
    }
    const v = Number(o.value) || 0;
    const w = STAGE_WEIGHT[o.stage] ?? 0.25;
    const weighted = v * w;
    months[month].deals += 1;
    months[month].pipeline_value += v;
    months[month].weighted_value += weighted;
    totalPipeline += v;
    totalWeighted += weighted;
  }

  const byMonth = Object.values(months)
    .map((m) => ({
      ...m,
      pipeline_value: Math.round(m.pipeline_value * 100) / 100,
      weighted_value: Math.round(m.weighted_value * 100) / 100,
    }))
    .sort((a, b) => {
      if (a.month === 'unscheduled') return 1;
      if (b.month === 'unscheduled') return -1;
      return a.month.localeCompare(b.month);
    });

  res.json({
    stage_weights: STAGE_WEIGHT,
    by_month: byMonth,
    summary: {
      open_deals: (data || []).length,
      pipeline_value: Math.round(totalPipeline * 100) / 100,
      weighted_forecast: Math.round(totalWeighted * 100) / 100,
    },
  });
});

export function registerSalesReportRoutes(api: express.Router) {
  api.use('/reports/sales', router);
}
