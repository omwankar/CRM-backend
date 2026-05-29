import express from "express";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { requireHrAccess } from "../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);

function isManagerRole(role?: string) {
  return role === "manager" || role === "super_admin" || role === "admin";
}

function sessionHours(clockIn: string, clockOut: string | null): number {
  const end = clockOut ? new Date(clockOut) : new Date();
  return (end.getTime() - new Date(clockIn).getTime()) / 3600000;
}

function monthBounds(month: string) {
  const [year, mon] = month.split("-").map(Number);
  return {
    year,
    mon,
    startDate: `${year}-${String(mon).padStart(2, "0")}-01`,
    endDate: new Date(year, mon, 0).toISOString().slice(0, 10),
    startIso: new Date(year, mon - 1, 1).toISOString(),
    endIso: new Date(year, mon, 0, 23, 59, 59).toISOString(),
  };
}

// GET /api/reports/quotations?from=&to=
router.get("/quotations", requireHrAccess, async (req, res) => {
  const from = (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("quotations")
    .select("id, status, enquiry_stage, outcome, deadline, created_at, clarusto_quote_sent_at")
    .gte("created_at", `${from}T00:00:00`)
    .lte("created_at", `${to}T23:59:59`);

  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const byStatus: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  const monthly: Record<string, number> = {};
  const today = new Date().toISOString().slice(0, 10);
  let overdue = 0;

  for (const q of rows) {
    byStatus[q.status] = (byStatus[q.status] || 0) + 1;
    const stage = q.enquiry_stage || "unknown";
    byStage[stage] = (byStage[stage] || 0) + 1;
    const m = (q.created_at || "").slice(0, 7);
    if (m) monthly[m] = (monthly[m] || 0) + 1;
    if (q.deadline && q.deadline < today && ["waiting_from_companies", "need_revision"].includes(q.status)) {
      overdue += 1;
    }
  }

  const won = rows.filter((q) => q.status === "approved").length;
  const lost = rows.filter((q) => q.status === "rejected").length;
  const cancelled = rows.filter((q) => q.status === "cancelled").length;

  res.json({
    from,
    to,
    total: rows.length,
    won,
    lost,
    cancelled,
    overdue,
    by_status: byStatus,
    by_stage: byStage,
    monthly_trend: Object.entries(monthly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count })),
  });
});

// GET /api/reports/leave?from=&to=
router.get("/leave", requireHrAccess, async (req, res) => {
  const from = (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("leave_requests")
    .select("id, requested_by, start_date, end_date, status, leave_type")
    .lte("start_date", to)
    .gte("end_date", from);

  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  const byType: Record<string, number> = { paid: 0, unpaid: 0, lop: 0 };
  const daysByUser: Record<string, number> = {};

  function rangeDays(start: string, end: string) {
    const s = new Date(start);
    const e = new Date(end);
    return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
  }

  for (const l of rows) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    if (l.leave_type) byType[l.leave_type] = (byType[l.leave_type] || 0) + 1;
    if (l.status === "approved") {
      daysByUser[l.requested_by] = (daysByUser[l.requested_by] || 0) + rangeDays(l.start_date, l.end_date);
    }
  }

  const userIds = Object.keys(daysByUser);
  let names: Record<string, string> = {};
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", userIds);
    names = (users || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
      acc[u.id] = u.full_name || u.email || "Employee";
      return acc;
    }, {});
  }

  res.json({
    from,
    to,
    total: rows.length,
    by_status: byStatus,
    by_type: byType,
    days_by_employee: userIds
      .map((id) => ({ user_id: id, name: names[id] || "Employee", days: daysByUser[id] }))
      .sort((a, b) => b.days - a.days),
  });
});

// GET /api/reports/timelog?month=YYYY-MM
// Idle = clocked minutes − logged minutes (per user, per month).
router.get("/timelog", async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const { startDate, endDate, startIso, endIso } = monthBounds(month);

  const managerView = isManagerRole(role);

  const [sessionsRes, logsRes] = await Promise.all([
    managerView
      ? supabase.from("clock_sessions").select("user_id, clock_in, clock_out").gte("clock_in", startIso).lte("clock_in", endIso)
      : supabase
          .from("clock_sessions")
          .select("user_id, clock_in, clock_out")
          .eq("user_id", userId)
          .gte("clock_in", startIso)
          .lte("clock_in", endIso),
    managerView
      ? supabase.from("time_logs").select("user_id, duration_minutes").gte("log_date", startDate).lte("log_date", endDate)
      : supabase
          .from("time_logs")
          .select("user_id, duration_minutes")
          .eq("user_id", userId)
          .gte("log_date", startDate)
          .lte("log_date", endDate),
  ]);

  if (sessionsRes.error) return res.status(500).json({ error: sessionsRes.error.message });
  if (logsRes.error) return res.status(500).json({ error: logsRes.error.message });

  const clockedMin: Record<string, number> = {};
  for (const s of sessionsRes.data || []) {
    clockedMin[s.user_id] = (clockedMin[s.user_id] || 0) + sessionHours(s.clock_in, s.clock_out) * 60;
  }
  const loggedMin: Record<string, number> = {};
  for (const l of logsRes.data || []) {
    loggedMin[l.user_id] = (loggedMin[l.user_id] || 0) + Number(l.duration_minutes || 0);
  }

  const allIds = Array.from(new Set([...Object.keys(clockedMin), ...Object.keys(loggedMin)]));
  let names: Record<string, string> = {};
  if (allIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", allIds);
    names = (users || []).reduce((acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
      acc[u.id] = u.full_name || u.email || "Employee";
      return acc;
    }, {});
  }

  const rows = allIds.map((id) => {
    const clocked = Math.round(clockedMin[id] || 0);
    const logged = Math.round(loggedMin[id] || 0);
    const idle = Math.max(0, clocked - logged);
    return {
      user_id: id,
      name: names[id] || "Employee",
      clocked_hours: Math.round((clocked / 60) * 100) / 100,
      logged_hours: Math.round((logged / 60) * 100) / 100,
      idle_hours: Math.round((idle / 60) * 100) / 100,
      utilization: clocked > 0 ? Math.round((logged / clocked) * 100) : 0,
    };
  });

  res.json({ month, manager_view: managerView, rows: rows.sort((a, b) => a.name.localeCompare(b.name)) });
});

// GET /api/reports/company-monthly?month=YYYY-MM
router.get("/company-monthly", requireHrAccess, async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const { startDate, endDate, startIso, endIso } = monthBounds(month);

  const [headcountRes, quotationsRes, sessionsRes, leavesRes, holidaysRes] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("quotations").select("id, status").gte("created_at", `${startDate}T00:00:00`).lte("created_at", `${endDate}T23:59:59`),
    supabase.from("clock_sessions").select("clock_in, clock_out").gte("clock_in", startIso).lte("clock_in", endIso),
    supabase.from("leave_requests").select("id, status").lte("start_date", endDate).gte("end_date", startDate),
    supabase.from("calendar_events").select("id").eq("event_type", "holiday").gte("date", startDate).lte("date", endDate),
  ]);

  const quotations = quotationsRes.data || [];
  let totalHours = 0;
  for (const s of sessionsRes.data || []) totalHours += sessionHours(s.clock_in, s.clock_out);

  res.json({
    month,
    headcount_active: headcountRes.count || 0,
    quotations: {
      received: quotations.length,
      won: quotations.filter((q) => q.status === "approved").length,
      lost: quotations.filter((q) => q.status === "rejected").length,
    },
    total_clock_hours: Math.round(totalHours * 100) / 100,
    leave_requests: (leavesRes.data || []).length,
    approved_leaves: (leavesRes.data || []).filter((l) => l.status === "approved").length,
    holidays: (holidaysRes.data || []).length,
  });
});

export function registerReportRoutes(api: express.Router) {
  api.use("/reports", router);
}
