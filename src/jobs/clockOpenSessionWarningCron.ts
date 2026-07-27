import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";

const UK_TIME_ZONE = "Europe/London";
const DEFAULT_SCHEDULE = "0 9 * * *";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function ukDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: UK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function sendOpenSessionWarnings() {
  const { data: openSessions, error } = await supabase
    .from("clock_sessions")
    .select("id, user_id, clock_in")
    .is("clock_out", null);

  if (error) {
    throw new Error(error.message);
  }

  const todayUk = ukDateKey();
  const staleSessions = (openSessions || []).filter((session) => ukDateKey(new Date(session.clock_in)) < todayUk);

  if (!staleSessions.length) {
    console.log("[clock-open-warning] No stale open sessions found");
    return;
  }

  const userIds = [...new Set(staleSessions.map((s) => s.user_id).filter(Boolean))];
  const dayStartIso = new Date(`${todayUk}T00:00:00.000Z`).toISOString();

  const { data: existingNotifications, error: existingError } = await supabase
    .from("notifications")
    .select("user_id")
    .eq("type", "open_session_warning")
    .gte("created_at", dayStartIso)
    .in("user_id", userIds);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const alreadyWarned = new Set((existingNotifications || []).map((n) => n.user_id));
  const rows = staleSessions
    .filter((session) => !alreadyWarned.has(session.user_id))
    .map((session) => ({
      user_id: session.user_id,
      type: "open_session_warning",
      title: "Open clock session",
      message: "You still have an open session from a previous day. Please review it on the Clock page.",
    }));

  if (!rows.length) {
    console.log("[clock-open-warning] Notifications already sent for today's stale sessions");
    return;
  }

  const { error: insertError } = await supabase.from("notifications").insert(rows);
  if (insertError) {
    throw new Error(insertError.message);
  }

  console.log(`[clock-open-warning] Sent ${rows.length} warning notification(s)`);
}

export function startClockOpenSessionWarningCron() {
  const schedule = process.env.CLOCK_OPEN_SESSION_WARNING_CRON || DEFAULT_SCHEDULE;
  const valid = cron.validate(schedule);

  if (!valid) {
    console.warn(`[clock-open-warning] Invalid cron "${schedule}" - using ${DEFAULT_SCHEDULE}`);
  }

  cron.schedule(
    valid ? schedule : DEFAULT_SCHEDULE,
    async () => {
      try {
        await sendOpenSessionWarnings();
      } catch (err) {
        console.error("[clock-open-warning] Failed:", err instanceof Error ? err.message : err);
      }
    },
    { timezone: UK_TIME_ZONE },
  );

  console.log(
    `[clock-open-warning] Cron scheduled: ${valid ? schedule : DEFAULT_SCHEDULE} (${UK_TIME_ZONE})`,
  );
}
