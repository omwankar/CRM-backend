import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { notifySuperAdmins } from "../lib/notifyAdmins.js";
import { normalizeAppRole } from "../lib/roles.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

function isSuperAdminRole(role?: string) {
  return normalizeAppRole(role) === "super_admin";
}

const schema = z.object({
  log_date: z.string(),
  duration_minutes: z.number().int().min(0).optional().default(0),
  description: z.string().min(1),
  started_at: z.string().optional().nullable(),
  ended_at: z.string().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  task_id: z.string().uuid().optional().nullable(),
  quotation_id: z.string().uuid().optional().nullable(),
});

const updateSchema = schema.partial();
const commentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

function preview(text: string, max = 120) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function notifyUser(userId: string | null | undefined, type: string, title: string, message: string) {
  if (!userId) return;
  await supabase.from("notifications").insert({
    user_id: userId,
    type,
    title,
    message,
  });
}

async function loadCommentsByLogIds(ids: string[]) {
  if (!ids.length) return {} as Record<string, any[]>;
  const { data, error } = await supabase
    .from("comments")
    .select("id, body, author_id, related_id, created_at")
    .eq("related_table", "time_logs")
    .in("related_id", ids)
    .order("created_at", { ascending: true });
  if (error) return {};

  const rows = data || [];
  const authorIds = Array.from(new Set(rows.map((r) => r.author_id).filter(Boolean))) as string[];
  let names: Record<string, string> = {};
  if (authorIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", authorIds);
    names = (users || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
      acc[u.id] = u.full_name || u.email || "Someone";
      return acc;
    }, {});
  }

  const byLog: Record<string, any[]> = {};
  for (const row of rows) {
    const logId = String(row.related_id);
    (byLog[logId] ||= []).push({
      id: row.id,
      body: row.body,
      author_id: row.author_id,
      author_name: row.author_id ? names[row.author_id] || "Someone" : "Someone",
      created_at: row.created_at,
    });
  }
  return byLog;
}

async function attachPeopleAndComments(logs: any[]) {
  if (!logs.length) return [];
  const userIds = Array.from(new Set(logs.map((l) => l.user_id).filter(Boolean)));
  let names: Record<string, string> = {};
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", userIds);
    names = (users || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
      acc[u.id] = u.full_name || u.email || "Employee";
      return acc;
    }, {});
  }
  const commentsByLog = await loadCommentsByLogIds(logs.map((l) => l.id));
  return logs.map((l) => ({
    ...l,
    user_name: l.user_id ? names[l.user_id] || "Employee" : "Employee",
    comments: commentsByLog[l.id] || [],
  }));
}

async function loadOwnedLog(id: string, userId: string, role?: string) {
  const { data } = await supabase.from("time_logs").select("id, user_id, log_date, description").eq("id", id).maybeSingle();
  if (!data) return { ok: false as const, status: 404, error: "Not found" };
  if (data.user_id !== userId && !isSuperAdminRole(role)) {
    return { ok: false as const, status: 403, error: "You can only open your own timesheet" };
  }
  return { ok: true as const, log: data };
}

// GET /api/timelogs?month=YYYY-MM&user_id=
router.get("/", async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const monthStart = `${year}-${String(mon).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, mon, 0).toISOString().slice(0, 10);

  const requestedUser = req.query.user_id as string | undefined;
  const superAdmin = isSuperAdminRole(role);

  if (requestedUser && !superAdmin) {
    return res.status(403).json({ error: "You can only view your own timesheet" });
  }

  let query = supabase
    .from("time_logs")
    .select("*")
    .gte("log_date", monthStart)
    .lte("log_date", monthEnd)
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (!superAdmin) {
    query = query.eq("user_id", userId);
  } else if (requestedUser) {
    query = query.eq("user_id", requestedUser);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: await attachPeopleAndComments(data || []) });
});

// POST /api/timelogs
router.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Please write what you did today.", issues: parsed.error.issues });
  }

  const payload = {
    user_id: userId,
    log_date: parsed.data.log_date,
    duration_minutes: parsed.data.duration_minutes ?? 0,
    description: parsed.data.description.trim(),
    started_at: parsed.data.started_at || null,
    ended_at: parsed.data.ended_at || null,
    project_id: parsed.data.project_id || null,
    task_id: parsed.data.task_id || null,
    quotation_id: parsed.data.quotation_id || null,
  };

  let { data, error } = await supabase.from("time_logs").insert(payload).select().single();
  if (error && /duration_minutes/i.test(error.message || "")) {
    const retry = await supabase
      .from("time_logs")
      .insert({ ...payload, duration_minutes: Math.max(1, payload.duration_minutes) })
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }
  if (error || !data) return res.status(500).json({ error: error?.message || "Could not save timesheet" });

  const actor = req.user?.full_name || req.user?.email || "An employee";
  try {
    await notifySuperAdmins(
      "timesheet",
      "Timesheet update",
      `${actor} posted work for ${parsed.data.log_date}: ${preview(parsed.data.description)}`,
      userId,
    );
  } catch {
    /* entry is saved */
  }

  const [row] = await attachPeopleAndComments([data]);
  res.status(201).json(row);
});

// POST /api/timelogs/:id/comments
router.post("/:id/comments", async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const owned = await loadOwnedLog(req.params.id, userId, role);
  if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

  const parsed = commentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Please write a comment." });
  }

  const insert = await supabase
    .from("comments")
    .insert({
      body: parsed.data.body,
      author_id: userId,
      related_table: "time_logs",
      related_id: req.params.id,
    })
    .select("id, body, author_id, related_id, created_at")
    .single();

  if (insert.error || !insert.data) {
    return res.status(500).json({ error: "Could not save the comment. Please try again." });
  }

  const actor = req.user?.full_name || req.user?.email || "Someone";
  const ownerId = owned.log.user_id;
  const dateLabel = owned.log.log_date;

  try {
    if (userId !== ownerId) {
      await notifyUser(
        ownerId,
        "timesheet_comment",
        "Comment on your timesheet",
        `${actor} commented on your ${dateLabel} timesheet: ${preview(parsed.data.body)}`,
      );
    } else {
      await notifySuperAdmins(
        "timesheet_comment",
        "Timesheet reply",
        `${actor} replied on their ${dateLabel} timesheet: ${preview(parsed.data.body)}`,
        userId,
      );
    }
  } catch {
    /* comment is saved */
  }

  const [withPeople] = await attachPeopleAndComments([{ ...owned.log, id: req.params.id }]);
  res.status(201).json({
    id: insert.data.id,
    body: insert.data.body,
    author_id: insert.data.author_id,
    author_name: actor,
    created_at: insert.data.created_at,
    log_id: req.params.id,
    comments: withPeople?.comments,
  });
});

// PUT /api/timelogs/:id
router.put("/:id", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const owned = await loadOwnedLog(req.params.id, userId, req.user?.role);
  if (!owned.ok) return res.status(owned.status).json({ error: owned.error });
  if (owned.log.user_id !== userId) {
    return res.status(403).json({ error: "You can only edit your own timesheet" });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("time_logs")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  const [row] = await attachPeopleAndComments([data]);
  res.json(row);
});

// DELETE /api/timelogs/:id
router.delete("/:id", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const owned = await loadOwnedLog(req.params.id, userId, req.user?.role);
  if (!owned.ok) return res.status(owned.status).json({ error: owned.error });
  if (owned.log.user_id !== userId && !isSuperAdminRole(req.user?.role)) {
    return res.status(403).json({ error: "You can only delete your own timesheet" });
  }

  const { error } = await supabase.from("time_logs").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerTimeLogRoutes(api: express.Router) {
  api.use("/timelogs", router);
}
