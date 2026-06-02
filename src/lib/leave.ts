import type { SupabaseClient } from "@supabase/supabase-js";

/** Inclusive list of YYYY-MM-DD date strings between start and end. */
export function eachDateInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const last = new Date(Date.UTC(ey, em - 1, ed));
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Count working days in an inclusive range, skipping weekends and the given holiday dates. */
export function computeWorkingDays(start: string, end: string, holidayDates: Set<string>): number {
  let count = 0;
  for (const dateStr of eachDateInRange(start, end)) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (day === 0 || day === 6) continue; // Sun / Sat
    if (holidayDates.has(dateStr)) continue;
    count++;
  }
  return count;
}

/** Set of holiday dates (YYYY-MM-DD) overlapping the inclusive range. */
export async function getHolidayDatesInRange(
  supabase: SupabaseClient,
  start: string,
  end: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("calendar_events")
    .select("date")
    .eq("event_type", "holiday")
    .gte("date", start)
    .lte("date", end);
  return new Set((data || []).map((h: { date: string }) => h.date));
}

export type LeaveUsage = {
  year: number;
  allowance: number;
  used: number;
  remaining: number;
};

/**
 * Paid-leave usage for a user in a calendar year. Consumed by all non-rejected
 * (pending + approved) paid leaves whose start_date falls in the year, so the
 * balance reflects the moment a request is submitted.
 */
export async function getLeaveUsage(
  supabase: SupabaseClient,
  userId: string,
  year: number,
): Promise<LeaveUsage> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const { data: user } = await supabase
    .from("users")
    .select("annual_leave_allowance")
    .eq("id", userId)
    .maybeSingle();
  const allowance = user?.annual_leave_allowance ?? 10;

  const { data: leaves } = await supabase
    .from("leave_requests")
    .select("start_date, end_date, working_days, leave_type, status")
    .eq("requested_by", userId)
    .eq("leave_type", "paid")
    .neq("status", "rejected")
    .gte("start_date", yearStart)
    .lte("start_date", yearEnd);

  let holidaySet: Set<string> | null = null;
  let used = 0;
  for (const l of leaves || []) {
    if (typeof l.working_days === "number") {
      used += l.working_days;
    } else {
      // Legacy rows without a stored count: compute on the fly.
      if (!holidaySet) holidaySet = await getHolidayDatesInRange(supabase, yearStart, yearEnd);
      used += computeWorkingDays(l.start_date, l.end_date, holidaySet);
    }
  }

  return { year, allowance, used, remaining: Math.max(0, allowance - used) };
}
