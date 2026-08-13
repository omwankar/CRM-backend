import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { createPunchRequestsForStaleSessions } from "../lib/clockForgotOut.js";

const UK_TIME_ZONE = "Europe/London";
const DEFAULT_SCHEDULE = "0 9 * * *";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export function startClockOpenSessionWarningCron() {
  const schedule = process.env.CLOCK_OPEN_SESSION_WARNING_CRON || DEFAULT_SCHEDULE;
  const valid = cron.validate(schedule);

  if (!valid) {
    console.warn(`[clock-forgot-out] Invalid cron "${schedule}" - using ${DEFAULT_SCHEDULE}`);
  }

  cron.schedule(
    valid ? schedule : DEFAULT_SCHEDULE,
    async () => {
      try {
        const result = await createPunchRequestsForStaleSessions(supabase);
        console.log(
          `[clock-forgot-out] morning check stale=${result.stale} created=${result.created}`,
        );
      } catch (err) {
        console.error("[clock-forgot-out] Morning check failed:", err instanceof Error ? err.message : err);
      }
    },
    { timezone: UK_TIME_ZONE },
  );

  console.log(
    `[clock-forgot-out] Morning cron scheduled: ${valid ? schedule : DEFAULT_SCHEDULE} (${UK_TIME_ZONE})`,
  );
}
