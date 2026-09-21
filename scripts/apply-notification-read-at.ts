/**
 * Apply notifications.read_at column for 24h expiry of read notifications.
 * Usage: npx tsx scripts/apply-notification-read-at.ts
 */
import "../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Prefer RPC if available; otherwise probe with a lightweight select/update path.
  // Supabase JS cannot run arbitrary DDL — instruct user if column missing.
  const probe = await supabase.from("notifications").select("id, read_at").limit(1);
  if (!probe.error) {
    console.log("notifications.read_at already available.");
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("is_read", true)
      .is("read_at", null);
    if (error) console.warn("Backfill skipped:", error.message);
    else console.log("Backfilled read_at for already-read rows (where missing).");
    return;
  }

  if (/read_at/i.test(probe.error.message) || /column/i.test(probe.error.message)) {
    console.error(
      "Column read_at is missing. Run this in the Supabase SQL editor:\n\n" +
        "ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;\n" +
        "UPDATE public.notifications SET read_at = COALESCE(read_at, NOW()) WHERE is_read = TRUE AND read_at IS NULL;\n",
    );
    process.exit(1);
  }

  throw new Error(probe.error.message);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
