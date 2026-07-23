import cron from "node-cron";
import { isGraphConfigured } from "../services/graphClient.js";
import { runEmailSync } from "../services/graphMailSync.js";

let syncInProgress = false;

export function startEmailSyncCron() {
  if (!isGraphConfigured()) {
    console.log("[email-sync] Microsoft Graph not configured — cron disabled");
    return;
  }

  const schedule = process.env.EMAIL_SYNC_CRON || "*/10 * * * *";
  if (!cron.validate(schedule)) {
    console.warn(`[email-sync] Invalid cron schedule "${schedule}" — using */10 * * * *`);
  }

  cron.schedule(schedule, async () => {
    if (syncInProgress) return;
    syncInProgress = true;
    try {
      const result = await runEmailSync();
      console.log(
        `[email-sync] Completed: ${result.mailboxes_synced} mailboxes, ${result.messages_upserted} messages`,
      );
    } catch (err) {
      console.error("[email-sync] Failed:", err instanceof Error ? err.message : err);
    } finally {
      syncInProgress = false;
    }
  });

  console.log(`[email-sync] Cron scheduled: ${schedule}`);
}
