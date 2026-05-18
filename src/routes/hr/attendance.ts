import express from "express";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../../middleware/auth.js";
import { requireHrAccess, requireManager } from "../../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

router.use(authMiddleware);
router.use(requireHrAccess);

function sessionHours(clockIn: string, clockOut: string | null): number {
  if (!clockOut) return 0;
  return (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3600000;
}

function dateInRange(dateStr: string, start: string, end: string): boolean {
  return dateStr >= start && dateStr <= end;
}

function daysInMonth(year: number, month: number): string[] {
  const last = new Date(year, month, 0).getDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    out.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

function countLeaveDaysInMonth(startDate: string, endDate: string, year: number, month: number): number {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const start = new Date(startDate);
  const end = new Date(endDate);
  let count = 0;
  const d = new Date(Math.max(start.getTime(), monthStart.getTime()));
  const last = new Date(Math.min(end.getTime(), monthEnd.getTime()));
  while (d <= last) {
    count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/** Team attendance + leave history for a month (HR only). */
router.get("/team", async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const monthStartStr = `${year}-${String(mon).padStart(2, "0")}-01`;
  const monthEndStr = new Date(year, mon, 0).toISOString().slice(0, 10);
  const startIso = new Date(year, mon - 1, 1).toISOString();
  const endIso = new Date(year, mon, 0, 23, 59, 59).toISOString();

  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select(
      "id, full_name, email, department, employee_id, designation, employment_type, work_mode, reporting_manager_id",
    )
    .eq("is_active", true)
    .order("employee_id", { ascending: true });

  if (usersErr) return res.status(500).json({ error: usersErr.message });

  const managerIds = Array.from(
    new Set((users || []).map((u) => u.reporting_manager_id).filter(Boolean)),
  ) as string[];

  let managersById: Record<string, string> = {};
  if (managerIds.length) {
    const { data: mgrs } = await supabase.from("users").select("id, full_name, email").in("id", managerIds);
    for (const m of mgrs || []) {
      managersById[m.id] = m.full_name || m.email || "";
    }
  }

  const [sessionsRes, leavesRes, holidaysRes] = await Promise.all([
    supabase
      .from("clock_sessions")
      .select("user_id, clock_in, clock_out")
      .gte("clock_in", startIso)
      .lte("clock_in", endIso),
    supabase
      .from("leave_requests")
      .select("*")
      .lte("start_date", monthEndStr)
      .gte("end_date", monthStartStr)
      .order("created_at", { ascending: false }),
    supabase
      .from("calendar_events")
      .select("id, date, title, holiday_pay_type")
      .eq("event_type", "holiday")
      .gte("date", monthStartStr)
      .lte("date", monthEndStr),
  ]);

  if (sessionsRes.error) return res.status(500).json({ error: sessionsRes.error.message });
  if (leavesRes.error) return res.status(500).json({ error: leavesRes.error.message });

  const hoursByUser: Record<string, number> = {};
  const daysByUser: Record<string, Set<string>> = {};

  for (const s of sessionsRes.data || []) {
    hoursByUser[s.user_id] = (hoursByUser[s.user_id] || 0) + sessionHours(s.clock_in, s.clock_out);
    if (!daysByUser[s.user_id]) daysByUser[s.user_id] = new Set();
    daysByUser[s.user_id].add(s.clock_in.slice(0, 10));
  }

  const leaves = leavesRes.data || [];
  const pendingLeaves = leaves.filter((l) => l.status === "pending");

  const rows = (users || []).map((u) => {
    const userLeaves = leaves.filter((l) => l.requested_by === u.id);
    const approved = userLeaves.filter((l) => l.status === "approved");
    let paidDays = 0;
    let unpaidDays = 0;
    let lopDays = 0;
    for (const l of approved) {
      const days = countLeaveDaysInMonth(l.start_date, l.end_date, year, mon);
      if (l.leave_type === "paid") paidDays += days;
      else if (l.leave_type === "lop") lopDays += days;
      else unpaidDays += days;
    }
    return {
      user_id: u.id,
      employee_id: u.employee_id,
      full_name: u.full_name,
      email: u.email,
      department: u.department,
      designation: u.designation,
      employment_type: u.employment_type,
      work_mode: u.work_mode,
      reporting_manager_name: u.reporting_manager_id
        ? managersById[u.reporting_manager_id] || null
        : null,
      total_hours: Math.round((hoursByUser[u.id] || 0) * 100) / 100,
      days_present: daysByUser[u.id]?.size || 0,
      leave_paid_days: paidDays,
      leave_unpaid_days: unpaidDays,
      leave_lop_days: lopDays,
      pending_leave_count: userLeaves.filter((l) => l.status === "pending").length,
    };
  });

  const userIds = new Set((users || []).map((u) => u.id));
  const enrichedLeaves = leaves
    .filter((l) => userIds.has(l.requested_by))
    .map((l) => {
      const u = users!.find((x) => x.id === l.requested_by);
      return {
        ...l,
        requester_name: u?.full_name || u?.email || "Employee",
        requester_employee_id: u?.employee_id,
      };
    });

  res.json({
    month,
    employees: rows,
    leaves: enrichedLeaves,
    pending_leaves: pendingLeaves.map((l) => {
      const u = users!.find((x) => x.id === l.requested_by);
      return {
        ...l,
        requester_name: u?.full_name || u?.email,
        requester_employee_id: u?.employee_id,
      };
    }),
    holidays: holidaysRes.data || [],
  });
});

/** Day-wise attendance for one employee in a month. */
router.get("/employee/:userId", async (req, res) => {
  const userId = req.params.userId;
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const monthStartStr = `${year}-${String(mon).padStart(2, "0")}-01`;
  const monthEndStr = new Date(year, mon, 0).toISOString().slice(0, 10);
  const startIso = new Date(year, mon - 1, 1).toISOString();
  const endIso = new Date(year, mon, 0, 23, 59, 59).toISOString();

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select(
      "id, full_name, email, department, employee_id, designation, employment_type, work_mode, monthly_salary, reporting_manager_id",
    )
    .eq("id", userId)
    .maybeSingle();

  if (userErr) return res.status(500).json({ error: userErr.message });
  if (!user) return res.status(404).json({ error: "Employee not found" });

  const [sessionsRes, leavesRes, holidaysRes] = await Promise.all([
    supabase
      .from("clock_sessions")
      .select("id, clock_in, clock_out, notes")
      .eq("user_id", userId)
      .gte("clock_in", startIso)
      .lte("clock_in", endIso)
      .order("clock_in", { ascending: true }),
    supabase
      .from("leave_requests")
      .select("*")
      .eq("requested_by", userId)
      .lte("start_date", monthEndStr)
      .gte("end_date", monthStartStr),
    supabase
      .from("calendar_events")
      .select("id, date, title, holiday_pay_type")
      .eq("event_type", "holiday")
      .gte("date", monthStartStr)
      .lte("date", monthEndStr),
  ]);

  if (sessionsRes.error) return res.status(500).json({ error: sessionsRes.error.message });
  if (leavesRes.error) return res.status(500).json({ error: leavesRes.error.message });

  const sessions = sessionsRes.data || [];
  const leaves = leavesRes.data || [];
  const holidays = holidaysRes.data || [];

  const sessionsByDate: Record<string, typeof sessions> = {};
  for (const s of sessions) {
    const d = s.clock_in.slice(0, 10);
    if (!sessionsByDate[d]) sessionsByDate[d] = [];
    sessionsByDate[d].push(s);
  }

  let totalHours = 0;
  let daysPresent = 0;
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  let lopDays = 0;

  const days = daysInMonth(year, mon).map((dateStr) => {
    const daySessions = sessionsByDate[dateStr] || [];
    const hours =
      Math.round(
        daySessions.reduce((acc, s) => acc + sessionHours(s.clock_in, s.clock_out), 0) * 100,
      ) / 100;

    const holiday = holidays.find((h) => h.date === dateStr) || null;
    const leave = leaves.find((l) => dateInRange(dateStr, l.start_date, l.end_date)) || null;

    const markers: string[] = [];
    if (holiday) {
      markers.push(holiday.holiday_pay_type === "unpaid" ? "unpaid_holiday" : "paid_holiday");
    }
    if (leave) {
      if (leave.status === "approved") {
        if (leave.leave_type === "paid") {
          markers.push("paid_leave");
          paidLeaveDays++;
        } else if (leave.leave_type === "lop") {
          markers.push("lop");
          lopDays++;
        } else {
          markers.push("unpaid_leave");
          unpaidLeaveDays++;
        }
      } else if (leave.status === "pending") {
        markers.push(`pending_${leave.leave_type}`);
      } else if (leave.status === "rejected") {
        markers.push("leave_rejected");
      }
    }
    if (daySessions.length > 0) {
      markers.push("present");
      totalHours += hours;
      daysPresent++;
    }
    if (markers.length === 0) {
      markers.push("absent");
    }

    return {
      date: dateStr,
      weekday: new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" }),
      markers,
      hours,
      sessions: daySessions.map((s) => ({
        id: s.id,
        clock_in: s.clock_in,
        clock_out: s.clock_out,
        notes: s.notes,
      })),
      holiday: holiday
        ? {
            id: holiday.id,
            title: holiday.title,
            holiday_pay_type: holiday.holiday_pay_type || "paid",
          }
        : null,
      leave: leave
        ? {
            id: leave.id,
            leave_type: leave.leave_type,
            status: leave.status,
            start_date: leave.start_date,
            end_date: leave.end_date,
            reason: leave.reason,
          }
        : null,
    };
  });

  res.json({
    month,
    employee: user,
    days,
    summary: {
      total_hours: Math.round(totalHours * 100) / 100,
      days_present: daysPresent,
      leave_paid_days: paidLeaveDays,
      leave_unpaid_days: unpaidLeaveDays,
      leave_lop_days: lopDays,
      holiday_count: holidays.length,
    },
    holidays,
  });
});

export function registerHrAttendanceRoutes(parent: express.Router) {
  parent.use("/attendance", router);
}
