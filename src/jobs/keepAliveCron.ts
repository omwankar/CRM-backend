import cron from "node-cron";

/**
 * Ping /api/health every 10 minutes so Render does not spin the service down.
 * First page load after idle is otherwise a 30–60s cold start.
 */
export function startKeepAliveCron() {
  const port = process.env.PORT || "4000";
  const base = (process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const url = `${base}/api/health`;

  cron.schedule("*/10 * * * *", async () => {
    try {
      await fetch(url, { method: "GET" });
    } catch (err) {
      console.warn("[keep-alive] ping failed:", err instanceof Error ? err.message : err);
    }
  });

  console.log(`[keep-alive] pinging ${url} every 10 minutes`);
}
