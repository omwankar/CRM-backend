import type { SupabaseClient } from "@supabase/supabase-js";

type SessionRow = { user_id: string; clock_in: string; clock_out: string | null };

function sessionHours(clockIn: string, clockOut: string | null): number {
  if (!clockOut) return 0;
  return (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3600000;
}

export async function computeAttendanceGrid(
  supabase: SupabaseClient,
  month: string,
  options?: { userId?: string },
) {
  const [year, mon] = month.split("-").map(Number);
  const monthStartStr = `${year}-${String(mon).padStart(2, "0")}-01`;
  const monthEndStr = new Date(year, mon, 0).toISOString().slice(0, 10);
  const startIso = new Date(year, mon - 1, 1).toISOString();
  const endIso = new Date(year, mon, 0, 23, 59, 59).toISOString();

  let usersQuery = supabase
    .from("users")
    .select("id, full_name, email, employee_id, department")
    .eq("is_active", true)
    .order("employee_id", { ascending: true });
  if (options?.userId) usersQuery = usersQuery.eq("id", options.userId);

  const { data: users, error: usersErr } = await usersQuery;
  if (usersErr) throw new Error(usersErr.message);

  const [sessionsRes, leavesRes, holidaysRes] = await Promise.all([
    supabase
      .from("clock_sessions")
      .select("user_id, clock_in, clock_out")
      .gte("clock_in", startIso)
      .lte("clock_in", endIso),
    supabase
      .from("leave_requests")
      .select("requested_by, start_date, end_date, leave_type, status")
      .lte("start_date", monthEndStr)
      .gte("end_date", monthStartStr),
    supabase
      .from("calendar_events")
      .select("date, title, holiday_pay_type")
      .eq("event_type", "holiday")
      .gte("date", monthStartStr)
      .lte("date", monthEndStr),
  ]);
  if (sessionsRes.error) throw new Error(sessionsRes.error.message);
  if (leavesRes.error) throw new Error(leavesRes.error.message);

  const sessionsByUserDate: Record<string, Record<string, SessionRow[]>> = {};
  for (const s of (sessionsRes.data || []) as SessionRow[]) {
    const date = s.clock_in.slice(0, 10);
    if (!sessionsByUserDate[s.user_id]) sessionsByUserDate[s.user_id] = {};
    if (!sessionsByUserDate[s.user_id][date]) sessionsByUserDate[s.user_id][date] = [];
    sessionsByUserDate[s.user_id][date].push(s);
  }

  const holidayByDate: Record<string, string> = {};
  for (const h of holidaysRes.data || []) {
    holidayByDate[h.date] = h.holiday_pay_type || "paid";
  }

  const leaves = leavesRes.data || [];
  const lastDay = new Date(year, mon, 0).getDate();
  const days = Array.from({ length: lastDay }, (_, i) => {
    const dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
    const dow = new Date(`${dateStr}T12:00:00`).getDay();
    return { date: dateStr, day: i + 1, is_weekend: dow === 0 || dow === 6 };
  });

  const employees = (users || []).map((u) => {
    const userLeaves = leaves.filter((l) => l.requested_by === u.id);
    const userSessions = sessionsByUserDate[u.id] || {};
    const cells = days.map((d) => {
      const daySessions = userSessions[d.date] || [];
      const holidayPay = holidayByDate[d.date];
      const leave = userLeaves.find((l) => d.date >= l.start_date && d.date <= l.end_date) || null;
      const hasSession = daySessions.length > 0;

      let marker = "none";
      if (holidayPay) {
        marker = holidayPay === "unpaid" ? "unpaid_holiday" : "paid_holiday";
      } else if (leave) {
        if (leave.status === "approved") {
          marker = leave.leave_type === "paid" ? "paid_leave" : leave.leave_type === "lop" ? "lop" : "unpaid_leave";
        } else if (leave.status === "pending") {
          marker = "pending";
        } else {
          marker = hasSession ? "present" : d.is_weekend ? "weekoff" : "absent";
        }
      } else if (hasSession) {
        marker = "present";
      } else if (d.is_weekend) {
        marker = "weekoff";
      } else {
        marker = "absent";
      }

      const hours =
        Math.round(daySessions.reduce((acc, s) => acc + sessionHours(s.clock_in, s.clock_out), 0) * 100) / 100;

      return {
        date: d.date,
        marker,
        hours,
        sessions: daySessions.map((s) => ({
          clock_in: s.clock_in,
          clock_out: s.clock_out,
        })),
      };
    });

    return {
      user_id: u.id,
      employee_id: u.employee_id,
      full_name: u.full_name || u.email,
      department: u.department,
      cells,
    };
  });

  return { month, days, employees };
}
