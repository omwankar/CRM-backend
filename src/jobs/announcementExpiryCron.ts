import cron from "node-cron";
import { purgeExpiredAnnouncements } from "../routes/announcements.js";

/** Soft-delete announcements past their 24h expiry. */
export function startAnnouncementExpiryCron() {
  const schedule = process.env.ANNOUNCEMENT_EXPIRY_CRON || "15 * * * *"; // hourly at :15
  if (!cron.validate(schedule)) {
    console.warn(`[announcements] Invalid cron "${schedule}" — using 15 * * * *`);
  }
  cron.schedule(cron.validate(schedule) ? schedule : "15 * * * *", async () => {
    try {
      await purgeExpiredAnnouncements();
    } catch (err) {
      console.error(
        "[announcements] Expiry purge failed:",
        err instanceof Error ? err.message : err,
      );
    }
  });
  console.log(`[announcements] Expiry cron scheduled: ${schedule}`);
}
