import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../../middleware/auth.js";
import { auditLog } from "../../middleware/auditLog.js";
import { requireHrAccess, requireSuperAdmin } from "../../middleware/requireRole.js";
import { computeWorkingDays, getHolidayDatesInRange } from "../../lib/leave.js";

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

const assignSchema = z.object({
  user_id: z.string().uuid(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  leave_type: z.enum(["paid", "lop"]),
  reason: z.string().max(500).optional(),
});

const decisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

function missingColumn(message: string) {
  const match =
    String(message || "").match(/Could not find the '([^']+)' column/i) ||
    String(message || "").match(/column (?:[\w.]+\.)?([a-zA-Z0-9_]+) does not exist/i);
  return match?.[1] || null;
}

async function insertLeaveWithFallback(payload: Record<string, unknown>) {
  let attempt: Record<string, unknown> = { ...payload };
  for (let i = 0; i < 10; i++) {
    const { data, error } = await supabase.from("leave_requests").insert(attempt).select().single();
    if (!error) return { data, error: null as null };

    const col = missingColumn(error.message || "");
    if (col && col in attempt) {
      const { [col]: _removed, ...rest } = attempt;
      attempt = rest;
      continue;
    }
    return { data: null, error };
  }
  return { data: null, error: { message: "Could not save the leave. Please try again." } };
}

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
      "id, requested_by, start_date, end_date, reason, leave_type, working_days, status, reviewed_by, reviewed_at, created_at",
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

/** Super Admin assigns paid leave or LOP to an employee (approved immediately). */
router.post("/assign", requireSuperAdmin, async (req, res) => {
  const reviewerId = req.user?.id;
  if (!reviewerId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { user_id, start_date, end_date, leave_type } = parsed.data;
  if (end_date < start_date) {
    return res.status(400).json({ error: "End date must be on or after start date" });
  }

  const { data: employee } = await supabase
    .from("users")
    .select("id, full_name, email, employee_id, is_active")
    .eq("id", user_id)
    .maybeSingle();

  if (!employee) return res.status(404).json({ error: "Employee not found" });
  if (employee.is_active === false) {
    return res.status(400).json({ error: "That employee is inactive" });
  }

  const { data: overlapping, error: overlapErr } = await supabase
    .from("leave_requests")
    .select("id, start_date, end_date, status, leave_type")
    .eq("requested_by", user_id)
    .neq("status", "rejected")
    .lte("start_date", end_date)
    .gte("end_date", start_date);

  if (overlapErr) return res.status(500).json({ error: "Could not check existing leave. Please try again." });
  if (overlapping && overlapping.length > 0) {
    const first = overlapping[0];
    return res.status(409).json({
      error: `This employee already has ${first.status} leave from ${first.start_date} to ${first.end_date}.`,
    });
  }

  const holidayDates = await getHolidayDatesInRange(supabase, start_date, end_date);
  const workingDays = computeWorkingDays(start_date, end_date, holidayDates);
  if (workingDays < 1) {
    return res.status(400).json({
      error: "That range has no working days (weekends and holidays are skipped).",
    });
  }

  const typeLabel = leave_type === "lop" ? "LOP (Loss of Pay)" : "paid leave";
  const reason =
    parsed.data.reason?.trim() || `Marked as ${typeLabel} by Super Admin`;

  const { data, error } = await insertLeaveWithFallback({
    requested_by: user_id,
    employee_id: employee.employee_id || null,
    start_date,
    end_date,
    reason,
    leave_type,
    working_days: workingDays,
    status: "approved",
    reviewed_by: reviewerId,
    reviewed_at: new Date().toISOString(),
  });

  if (error || !data) {
    const msg = String(error?.message || "").toLowerCase();
    if (msg.includes("leave_type") || msg.includes("check constraint")) {
      return res.status(400).json({
        error: `Could not mark as ${typeLabel}. Paid leave and LOP must be allowed on leave requests.`,
      });
    }
    return res.status(500).json({ error: "Could not mark leave. Please try again." });
  }

  const who = employee.full_name || employee.email || "Employee";
  try {
    await notifyUser(
      user_id,
      leave_type === "lop" ? "Marked as LOP" : "Marked as paid leave",
      `${who}: ${typeLabel} from ${start_date} to ${end_date} (${workingDays} working day${workingDays === 1 ? "" : "s"}) has been applied by Super Admin.`,
    );
  } catch {
    /* leave is already saved */
  }

  res.status(201).json(data);
});

router.patch("/:id", requireSuperAdmin, async (req, res) => {
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
