import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../../middleware/auth.js";
import { auditLog } from "../../middleware/auditLog.js";
import { requireHrAccess, requireManager } from "../../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

router.use(authMiddleware);

// Approve/reject only — submit/list moved to /api/clock/leave-requests
router.use((req, res, next) => {
  if (req.method === "PATCH") return next();
  return requireHrAccess(req, res, next);
});
router.use(auditLog);

const submitSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  reason: z.string().optional(),
  leave_type: z.enum(["paid", "unpaid", "lop"]).default("unpaid"),
});

const decisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

function isManagerRole(role?: string) {
  return role === "manager" || role === "super_admin" || role === "admin";
}

async function notifyUser(userId: string, title: string, message: string) {
  await supabase.from("notifications").insert({
    user_id: userId,
    type: "leave",
    title,
    message,
  });
}

router.get("/", async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const scope = req.query.scope as string | undefined;
  const status = req.query.status as string | undefined;

  let query = supabase
    .from("leave_requests")
    .select(
      "id, requested_by, start_date, end_date, reason, status, reviewed_by, reviewed_at, created_at",
    )
    .order("created_at", { ascending: false });

  if (!isManagerRole(role) || scope === "mine") {
    query = query.eq("requested_by", userId);
  }
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const userIds = Array.from(
    new Set((data || []).flatMap((r) => [r.requested_by, r.reviewed_by]).filter(Boolean)),
  ) as string[];

  let usersMap: Record<string, { full_name?: string; email?: string }> = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", userIds);
    usersMap = (users || []).reduce(
      (acc: Record<string, { full_name?: string; email?: string }>, u: { id: string; full_name?: string; email?: string }) => {
        acc[u.id] = u;
        return acc;
      },
      {},
    );
  }

  const rows = (data || []).map((r) => ({
    ...r,
    requester_name:
      usersMap[r.requested_by]?.full_name || usersMap[r.requested_by]?.email || "Employee",
    reviewer_name: r.reviewed_by
      ? usersMap[r.reviewed_by]?.full_name || usersMap[r.reviewed_by]?.email
      : null,
  }));

  res.json({ data: rows });
});

/** Approved leaves as calendar events (for calendar merge). */
router.get("/calendar", async (req, res) => {
  const { start_date, end_date } = req.query;
  let query = supabase
    .from("leave_requests")
    .select("id, requested_by, start_date, end_date, reason, status")
    .eq("status", "approved");

  if (start_date) query = query.gte("end_date", start_date as string);
  if (end_date) query = query.lte("start_date", end_date as string);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const userIds = Array.from(new Set((data || []).map((r) => r.requested_by)));
  let usersMap: Record<string, string> = {};
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", userIds);
    usersMap = (users || []).reduce(
      (acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
        acc[u.id] = u.full_name || u.email || "Employee";
        return acc;
      },
      {},
    );
  }

  const events = (data || []).map((r) => ({
    id: r.id,
    date: r.start_date,
    title: `Leave — ${usersMap[r.requested_by] || "Employee"}`,
    event_type: "leave" as const,
    start_date: r.start_date,
    end_date: r.end_date,
    description: r.reason,
  }));

  res.json({ data: events });
});

router.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  if (parsed.data.end_date < parsed.data.start_date) {
    return res.status(400).json({ error: "End date must be on or after start date" });
  }

  const { data: profile } = await supabase
    .from("users")
    .select("employee_id")
    .eq("id", userId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("leave_requests")
    .insert({
      requested_by: userId,
      employee_id: profile?.employee_id || null,
      start_date: parsed.data.start_date,
      end_date: parsed.data.end_date,
      reason: parsed.data.reason,
      leave_type: parsed.data.leave_type,
      status: "pending",
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch("/:id", requireManager, async (req, res) => {
  const reviewerId = req.user?.id;
  if (!reviewerId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data: existing } = await supabase
    .from("leave_requests")
    .select("id, requested_by, status, start_date, end_date")
    .eq("id", req.params.id)
    .maybeSingle();

  if (!existing) return res.status(404).json({ error: "Leave request not found" });
  if (existing.status !== "pending") {
    return res.status(400).json({ error: "Leave request already processed" });
  }

  const { data, error } = await supabase
    .from("leave_requests")
    .update({
      status: parsed.data.status,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const label = parsed.data.status === "approved" ? "approved" : "rejected";
  await notifyUser(
    existing.requested_by,
    `Leave ${label}`,
    `Your leave request (${existing.start_date} to ${existing.end_date}) was ${label}.`,
  );

  res.json(data);
});

export function registerHrLeaveRoutes(parent: express.Router) {
  parent.use("/leaves", router);
}
