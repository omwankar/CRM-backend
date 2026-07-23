import cron from 'node-cron';
import { notifyOverdueTasks } from '../routes/tasks.js';

export function startTaskOverdueCron() {
  // Daily 09:00 local server time
  const schedule = process.env.TASK_OVERDUE_CRON || '0 9 * * *';
  if (!cron.validate(schedule)) {
    console.warn(`[tasks-overdue] Invalid cron "${schedule}" — using 0 9 * * *`);
  }
  cron.schedule(cron.validate(schedule) ? schedule : '0 9 * * *', async () => {
    try {
      const n = await notifyOverdueTasks();
      console.log(`[tasks-overdue] Notified for ${n} overdue task(s)`);
    } catch (err) {
      console.error('[tasks-overdue] Failed:', err instanceof Error ? err.message : err);
    }
  });
  console.log(`[tasks-overdue] Cron scheduled: ${schedule}`);
}
