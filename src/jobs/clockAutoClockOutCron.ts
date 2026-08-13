import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { autoClockOutAtEod } from "../lib/clockForgotOut.js";

const UK_TIME_ZONE = "Europe/London";
const DEFAULT_SCHEDULE = "0 18 * * *";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** 18:00 UK: auto clock-out open sessions and create punch requests. */
export function startClockAutoClockOutCron() {
  const schedule = process.env.CLOCK_AUTO_OUT_CRON || DEFAULT_SCHEDULE;
  const valid = cron.validate(schedule);

  if (!valid) {
    console.warn(`[clock-eod] Invalid cron "${schedule}" - using ${DEFAULT_SCHEDULE}`);
  }

  cron.schedule(
    valid ? schedule : DEFAULT_SCHEDULE,
    async () => {
      try {
        const result = await autoClockOutAtEod(supabase);
        console.log(
          `[clock-eod] closed=${result.closed} punch_requests=${result.punchRequests} open_before=${result.open}`,
        );
      } catch (err) {
        console.error("[clock-eod] Failed:", err instanceof Error ? err.message : err);
      }
    },
    { timezone: UK_TIME_ZONE },
  );

  console.log(
    `[clock-eod] Auto clock-out scheduled: ${valid ? schedule : DEFAULT_SCHEDULE} (${UK_TIME_ZONE})`,
  );
}
