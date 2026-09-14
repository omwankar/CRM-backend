import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';
import { normalizeAppRole } from '../lib/roles.js';
import { notifySuperAdmins } from '../lib/notifyAdmins.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const DAY_MS = 24 * 60 * 60 * 1000;
const ESCALATE_REMIND_DAYS = 2; // remind the responsible person again
const ESCALATE_ADMIN_DAYS = 5; // alert team leads / super admins

const entityTypeEnum = z.enum(['lead', 'enquiry', 'quotation', 'buyer', 'opportunity', 'email', 'call', 'other']);
const followUpTypeEnum = z.enum(['email', 'call', 'quotation', 'meeting', 'other']);
const emailStatusEnum = z.enum(['email_sent', 'reply_received', 'follow_up_pending', 'follow_up_completed']);
const statusEnum = z.enum(['pending', 'completed', 'cancelled']);

const createSchema = z.object({
  title: z.string().trim().min(3),
  description: z.string().optional().nullable(),
  entity_type: entityTypeEnum.optional(),
  entity_id: z.string().uuid().optional().nullable(),
  entity_label: z.string().trim().optional().nullable(),
  follow_up_type: followUpTypeEnum.optional(),
  email_status: emailStatusEnum.optional().nullable(),
  due_at: z.string().min(10),
  assigned_to: z.string().uuid().optional().nullable(),
  watchers: z.array(z.string().uuid()).optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(3).optional(),
  description: z.string().optional().nullable(),
  entity_type: entityTypeEnum.optional(),
  entity_id: z.string().uuid().optional().nullable(),
  entity_label: z.string().trim().optional().nullable(),
  follow_up_type: followUpTypeEnum.optional(),
  email_status: emailStatusEnum.optional().nullable(),
  due_at: z.string().min(10).optional(),
  status: statusEnum.optional(),
  assigned_to: z.string().uuid().optional().nullable(),
  watchers: z.array(z.string().uuid()).optional(),
});

function isPrivileged(role?: string) {
  const r = normalizeAppRole(role);
  return r === 'super_admin' || r === 'manager';
}

async function addEvent(followUpId: string, actorId: string | null, action: string, detail?: string) {
  const { error } = await supabase.from('follow_up_events').insert({
    follow_up_id: followUpId,
    actor_id: actorId,
    action,
    detail: detail || null,
  });
  if (error) console.error('[follow_up_events]', error.message);
}

async function notifyUsers(userIds: string[], type: string, title: string, message: string) {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (!unique.length) return;
  const { error } = await supabase.from('notifications').insert(
    unique.map((id) => ({ user_id: id, type, title, message })),
  );
  if (error) console.error('[followups notify]', error.message);
}

async function namesFor(ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean))) as string[];
  if (!unique.length) return {};
  const { data } = await supabase.from('users').select('id, full_name, email').in('id', unique);
  const map: Record<string, string> = {};
  for (const u of data || []) map[u.id] = u.full_name || u.email || 'User';
  return map;
}

function enrich(rows: any[], names: Record<string, string>) {
  const now = Date.now();
  return rows.map((f) => {
    const due = new Date(f.due_at).getTime();
    const overdueDays = f.status === 'pending' && due < now ? Math.floor((now - due) / DAY_MS) : 0;
    return {
      ...f,
      assigned_to_name: f.assigned_to ? names[f.assigned_to] || null : null,
      created_by_name: f.created_by ? names[f.created_by] || null : null,
      completed_by_name: f.completed_by ? names[f.completed_by] || null : null,
      watcher_names: (f.watchers || []).map((w: string) => names[w]).filter(Boolean),
      overdue_days: overdueDays,
    };
  });
}

// ------------------------------------------------------------------
// Escalation — overdue 2 days: remind assignee; overdue 5 days: alert
// assignee + super admins. Runs lazily (throttled) and on an interval.
// ------------------------------------------------------------------
let lastEscalationRun = 0;

export async function runFollowUpEscalations() {
  const now = Date.now();
  const { data: overdue, error } = await supabase
    .from('follow_ups')
    .select('id, title, due_at, assigned_to, created_by, escalation_level, entity_label')
    .eq('status', 'pending')
    .lt('due_at', new Date(now - ESCALATE_REMIND_DAYS * DAY_MS).toISOString())
    .lt('escalation_level', 2)
    .limit(200);
  if (error || !overdue?.length) return;

  for (const f of overdue) {
    const overdueDays = Math.floor((now - new Date(f.due_at).getTime()) / DAY_MS);
    const label = f.entity_label ? ` (${f.entity_label})` : '';

    if (overdueDays >= ESCALATE_ADMIN_DAYS && f.escalation_level < 2) {
      await notifyUsers(
        [f.assigned_to].filter(Boolean) as string[],
        'followup',
        'Follow-up seriously overdue',
        `"${f.title}"${label} is ${overdueDays} days overdue. Please action it now — super admins have been alerted.`,
      );
      await notifySuperAdmins(
        'followup',
        'Follow-up escalation',
        `Follow-up "${f.title}"${label} is ${overdueDays} days overdue and still pending.`,
        f.assigned_to || undefined,
      );
      await supabase
        .from('follow_ups')
        .update({ escalation_level: 2, last_escalated_at: new Date().toISOString() })
        .eq('id', f.id);
      await addEvent(f.id, null, 'escalated', `Escalated to super admins after ${overdueDays} days overdue`);
    } else if (overdueDays >= ESCALATE_REMIND_DAYS && f.escalation_level < 1) {
      await notifyUsers(
        [f.assigned_to].filter(Boolean) as string[],
        'followup',
        'Follow-up overdue reminder',
        `"${f.title}"${label} is ${overdueDays} days overdue. Please follow up or reschedule it.`,
      );
      await supabase
        .from('follow_ups')
        .update({ escalation_level: 1, last_escalated_at: new Date().toISOString() })
        .eq('id', f.id);
      await addEvent(f.id, null, 'escalated', `Reminder sent to assignee after ${overdueDays} days overdue`);
    }
  }
}

async function maybeRunEscalations() {
  const now = Date.now();
  if (now - lastEscalationRun < 10 * 60 * 1000) return; // at most every 10 min
  lastEscalationRun = now;
  runFollowUpEscalations().catch((e) => console.error('[followup escalation]', e));
}

// ------------------------------------------------------------------
// GET /followups — list (scope=mine|all, bucket=overdue|today|soon|pending|completed|all)
// ------------------------------------------------------------------
router.get('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  await maybeRunEscalations();

  const privileged = isPrivileged(req.user?.role);
  const scope = privileged && req.query.scope === 'all' ? 'all' : 'mine';
  const bucket = String(req.query.bucket || 'all');
  const assignedTo = req.query.assigned_to ? String(req.query.assigned_to) : '';

  let query = supabase.from('follow_ups').select('*').order('due_at', { ascending: true }).limit(500);

  if (scope === 'mine') {
    query = query.or(`assigned_to.eq.${userId},created_by.eq.${userId},watchers.cs.{${userId}}`);
  }
  if (assignedTo && privileged) query = query.eq('assigned_to', assignedTo);

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + DAY_MS);
  const soonEnd = new Date(startOfToday.getTime() + 4 * DAY_MS); // today + 3 days

  if (bucket === 'overdue') {
    query = query.eq('status', 'pending').lt('due_at', now.toISOString());
  } else if (bucket === 'today') {
    query = query.eq('status', 'pending').gte('due_at', now.toISOString()).lt('due_at', endOfToday.toISOString());
  } else if (bucket === 'soon') {
    query = query.eq('status', 'pending').gte('due_at', endOfToday.toISOString()).lt('due_at', soonEnd.toISOString());
  } else if (bucket === 'pending') {
    query = query.eq('status', 'pending');
  } else if (bucket === 'completed') {
    query = query.eq('status', 'completed').order('completed_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const names = await namesFor(
    rows.flatMap((f: any) => [f.assigned_to, f.created_by, f.completed_by, ...(f.watchers || [])]),
  );
  res.json({ data: enrich(rows, names), scope });
});

// ------------------------------------------------------------------
// GET /followups/summary — colored bucket counts for dashboard
// ------------------------------------------------------------------
router.get('/summary', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  await maybeRunEscalations();

  const privileged = isPrivileged(req.user?.role);
  const scope = privileged && req.query.scope === 'all' ? 'all' : 'mine';

  let query = supabase.from('follow_ups').select('id, due_at, status, completed_at');
  if (scope === 'mine') {
    query = query.or(`assigned_to.eq.${userId},created_by.eq.${userId},watchers.cs.{${userId}}`);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + DAY_MS;
  const soonEnd = startOfToday.getTime() + 4 * DAY_MS;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  let overdue = 0;
  let dueToday = 0;
  let dueSoon = 0;
  let upcoming = 0;
  let completedThisMonth = 0;
  for (const f of data || []) {
    if (f.status === 'completed') {
      if (f.completed_at && new Date(f.completed_at).getTime() >= monthStart.getTime()) completedThisMonth++;
      continue;
    }
    if (f.status !== 'pending') continue;
    const due = new Date(f.due_at).getTime();
    if (due < now) overdue++;
    else if (due < endOfToday) dueToday++;
    else if (due < soonEnd) dueSoon++;
    else upcoming++;
  }

  res.json({ overdue, due_today: dueToday, due_soon: dueSoon, upcoming, completed_this_month: completedThisMonth, scope });
});

// ------------------------------------------------------------------
// GET /followups/:id/events — full audit history
// ------------------------------------------------------------------
router.get('/:id/events', async (req, res) => {
  const { data, error } = await supabase
    .from('follow_up_events')
    .select('*')
    .eq('follow_up_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  const names = await namesFor((data || []).map((e: any) => e.actor_id));
  res.json(
    (data || []).map((e: any) => ({
      ...e,
      actor_name: e.actor_id ? names[e.actor_id] || null : 'System',
    })),
  );
});

// ------------------------------------------------------------------
// POST /followups — create
// ------------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const assignedTo = parsed.data.assigned_to || userId;
  const emailStatus =
    parsed.data.follow_up_type === 'email'
      ? parsed.data.email_status || 'follow_up_pending'
      : parsed.data.email_status || null;

  const { data, error } = await supabase
    .from('follow_ups')
    .insert({
      ...parsed.data,
      assigned_to: assignedTo,
      email_status: emailStatus,
      watchers: parsed.data.watchers || [],
      created_by: userId,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  const actor = req.user?.full_name || req.user?.email || 'Someone';
  await addEvent(data.id, userId, 'created', `Created and assigned to ${assignedTo === userId ? 'self' : 'a teammate'}, due ${new Date(data.due_at).toUTCString()}`);

  const label = data.entity_label ? ` (${data.entity_label})` : '';
  if (assignedTo !== userId) {
    await addEvent(data.id, userId, 'assigned', 'Assigned on creation');
    await notifyUsers([assignedTo], 'followup', 'Follow-up assigned to you', `${actor} assigned you a follow-up: "${data.title}"${label}.`);
  }
  const watcherIds = (data.watchers || []).filter((w: string) => w !== userId && w !== assignedTo);
  if (watcherIds.length) {
    await notifyUsers(watcherIds, 'followup', 'Added as follow-up watcher', `${actor} added you as a watcher on "${data.title}"${label}.`);
  }

  res.status(201).json(data);
});

// ------------------------------------------------------------------
// PUT /followups/:id — update / reassign / reschedule / status
// ------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data: existing } = await supabase.from('follow_ups').select('*').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Follow-up not found' });

  const privileged = isPrivileged(req.user?.role);
  if (!privileged && existing.created_by !== userId && existing.assigned_to !== userId) {
    return res.status(403).json({ error: 'Only the creator, assignee, or an admin can update this follow-up' });
  }

  const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };

  const completing = parsed.data.status === 'completed' && existing.status !== 'completed';
  const reopening = parsed.data.status === 'pending' && existing.status === 'completed';
  if (completing) {
    patch.completed_at = new Date().toISOString();
    patch.completed_by = userId;
    if (existing.follow_up_type === 'email' && !parsed.data.email_status) {
      patch.email_status = 'follow_up_completed';
    }
  }
  if (reopening) {
    patch.completed_at = null;
    patch.completed_by = null;
    patch.escalation_level = 0;
  }
  // Rescheduling clears escalation so reminders fire again for the new date
  if (parsed.data.due_at && parsed.data.due_at !== existing.due_at) {
    patch.escalation_level = 0;
    patch.last_escalated_at = null;
  }

  const { data, error } = await supabase
    .from('follow_ups')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message || 'Update failed' });

  const actor = req.user?.full_name || req.user?.email || 'Someone';
  const label = data.entity_label ? ` (${data.entity_label})` : '';

  // Audit history + notifications
  if (parsed.data.assigned_to && parsed.data.assigned_to !== existing.assigned_to) {
    const names = await namesFor([parsed.data.assigned_to, existing.assigned_to]);
    await addEvent(
      data.id,
      userId,
      'assigned',
      `Reassigned from ${names[existing.assigned_to] || 'unassigned'} to ${names[parsed.data.assigned_to] || 'user'}`,
    );
    if (parsed.data.assigned_to !== userId) {
      await notifyUsers([parsed.data.assigned_to], 'followup', 'Follow-up assigned to you', `${actor} assigned you the follow-up "${data.title}"${label}.`);
    }
  }
  if (parsed.data.due_at && parsed.data.due_at !== existing.due_at) {
    await addEvent(data.id, userId, 'rescheduled', `Due date moved to ${new Date(parsed.data.due_at).toUTCString()}`);
  }
  if (parsed.data.email_status && parsed.data.email_status !== existing.email_status) {
    await addEvent(data.id, userId, 'email_status', `Email status changed to ${parsed.data.email_status.replace(/_/g, ' ')}`);
  }
  if (completing) {
    await addEvent(data.id, userId, 'completed', 'Marked as completed');
    const toNotify = [existing.created_by, ...(existing.watchers || [])].filter((u: string) => u && u !== userId);
    await notifyUsers(toNotify, 'followup', 'Follow-up completed', `${actor} completed the follow-up "${data.title}"${label}.`);
  }
  if (reopening) await addEvent(data.id, userId, 'reopened', 'Reopened');
  if (parsed.data.status === 'cancelled' && existing.status !== 'cancelled') {
    await addEvent(data.id, userId, 'cancelled', 'Cancelled');
  }
  if (parsed.data.watchers) {
    const added = parsed.data.watchers.filter((w) => !(existing.watchers || []).includes(w));
    if (added.length) {
      await addEvent(data.id, userId, 'watchers', 'Watchers updated');
      await notifyUsers(
        added.filter((w) => w !== userId),
        'followup',
        'Added as follow-up watcher',
        `${actor} added you as a watcher on "${data.title}"${label}.`,
      );
    }
  }
  if (
    !completing &&
    !reopening &&
    ((parsed.data.title && parsed.data.title !== existing.title) ||
      (parsed.data.description !== undefined && parsed.data.description !== existing.description))
  ) {
    await addEvent(data.id, userId, 'updated', 'Details edited');
  }

  const names = await namesFor([data.assigned_to, data.created_by, data.completed_by, ...(data.watchers || [])]);
  res.json(enrich([data], names)[0]);
});

// ------------------------------------------------------------------
// DELETE /followups/:id
// ------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data: existing } = await supabase
    .from('follow_ups')
    .select('id, created_by')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Follow-up not found' });

  if (!isPrivileged(req.user?.role) && existing.created_by !== userId) {
    return res.status(403).json({ error: 'Only the creator or an admin can delete this follow-up' });
  }

  const { error } = await supabase.from('follow_ups').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerFollowUpRoutes(api: express.Router) {
  api.use('/followups', router);
  // Proactive escalation sweep every hour while the server is up
  setInterval(() => {
    runFollowUpEscalations().catch((e) => console.error('[followup escalation]', e));
  }, 60 * 60 * 1000);
  setTimeout(() => {
    runFollowUpEscalations().catch((e) => console.error('[followup escalation]', e));
  }, 30 * 1000);
}
