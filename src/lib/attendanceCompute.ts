import type { SupabaseClient } from "@supabase/supabase-js";

type Session = { id: string; clock_in: string; clock_out: string | null; notes: string | null };
type Leave = {
  id: string;
  leave_type: string;
  status: string;
  start_date: string;
  end_date: string;
  reason: string | null;
};
type Holiday = { id: string; date: string; title: string; holiday_pay_type: string | null };

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

/**
 * Build the day-by-day attendance grid + monthly summary for a single user.
 * Shared by the HR per-employee view and the self-service Leave Tracker.
 */
export async function computeEmployeeMonthAttendance(
  supabase: SupabaseClient,
  userId: string,
  month: string,
) {
  const [year, mon] = month.split("-").map(Number);
  const monthStartStr = `${year}-${String(mon).padStart(2, "0")}-01`;
  const monthEndStr = new Date(year, mon, 0).toISOString().slice(0, 10);
  const startIso = new Date(year, mon - 1, 1).toISOString();
  const endIso = new Date(year, mon, 0, 23, 59, 59).toISOString();

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

  if (sessionsRes.error) throw new Error(sessionsRes.error.message);
  if (leavesRes.error) throw new Error(leavesRes.error.message);

  const sessions = (sessionsRes.data || []) as Session[];
  const leaves = (leavesRes.data || []) as Leave[];
  const holidays = (holidaysRes.data || []) as Holiday[];

  const sessionsByDate: Record<string, Session[]> = {};
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
      Math.round(daySessions.reduce((acc, s) => acc + sessionHours(s.clock_in, s.clock_out), 0) * 100) / 100;

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
        ? { id: holiday.id, title: holiday.title, holiday_pay_type: holiday.holiday_pay_type || "paid" }
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

  return {
    month,
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
  };
}
