import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";

const UK_TIME_ZONE = "Europe/London";
const DEFAULT_SCHEDULE = "0 18 * * *";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function autoClockOutOpenSessions() {
  const { data: openSessions, error } = await supabase
    .from("clock_sessions")
    .select("id")
    .is("clock_out", null);

  if (error) {
    throw new Error(error.message);
  }

  if (!openSessions?.length) {
    console.log("[clock-auto-out] No open sessions to close");
    return;
  }

  const nowIso = new Date().toISOString();
  let closed = 0;

  for (const session of openSessions) {
    const { error: updateError } = await supabase
      .from("clock_sessions")
      .update({ clock_out: nowIso })
      .eq("id", session.id)
      .is("clock_out", null);

    if (!updateError) {
      closed += 1;
    }
  }

  console.log(`[clock-auto-out] Auto clocked out ${closed} session(s) at ${nowIso}`);
}

/** Auto-close any open clock session at a fixed UK time. */
export function startClockAutoClockOutCron() {
  const schedule = process.env.CLOCK_AUTO_OUT_CRON || DEFAULT_SCHEDULE;
  const valid = cron.validate(schedule);

  if (!valid) {
    console.warn(`[clock-auto-out] Invalid cron "${schedule}" - using ${DEFAULT_SCHEDULE}`);
  }

  cron.schedule(
    valid ? schedule : DEFAULT_SCHEDULE,
    async () => {
      try {
        await autoClockOutOpenSessions();
      } catch (err) {
        console.error("[clock-auto-out] Failed:", err instanceof Error ? err.message : err);
      }
    },
    { timezone: UK_TIME_ZONE },
  );

  console.log(
    `[clock-auto-out] Cron scheduled: ${valid ? schedule : DEFAULT_SCHEDULE} (${UK_TIME_ZONE})`,
  );
}
