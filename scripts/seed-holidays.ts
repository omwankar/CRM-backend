/**
 * Seed company holidays (paid) into calendar_events for 2026 and 2027.
 * Idempotent — skips dates that already have a holiday.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-holidays.ts
 */
import "../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const HOLIDAYS: Array<{ date: string; title: string }> = [
  // 2026
  { date: "2026-01-01", title: "New Year's Day" },
  { date: "2026-01-26", title: "Republic Day" },
  { date: "2026-04-03", title: "Good Friday" },
  { date: "2026-05-04", title: "Early May Bank Holiday" },
  { date: "2026-08-15", title: "Independence Day" },
  { date: "2026-11-08", title: "Diwali" },
  { date: "2026-12-25", title: "Christmas Day" },
  { date: "2026-12-28", title: "Boxing Day (substitute)" },
  // 2027
  { date: "2027-01-01", title: "New Year's Day" },
  { date: "2027-01-26", title: "Republic Day" },
  { date: "2027-03-26", title: "Good Friday" },
  { date: "2027-05-03", title: "Early May Bank Holiday" },
  { date: "2027-08-15", title: "Independence Day" },
  { date: "2027-10-20", title: "Diwali" },
  { date: "2027-12-27", title: "Christmas substitute" },
  { date: "2027-12-28", title: "Boxing Day substitute" },
];

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: existing, error: readErr } = await supabase
    .from("calendar_events")
    .select("date")
    .eq("event_type", "holiday")
    .gte("date", "2026-01-01")
    .lte("date", "2027-12-31");
  if (readErr) throw new Error(readErr.message);

  const have = new Set((existing || []).map((r: { date: string }) => String(r.date).slice(0, 10)));
  const toInsert = HOLIDAYS.filter((h) => !have.has(h.date));

  console.log(`Existing holidays 2026–2027: ${have.size}`);
  if (!toInsert.length) {
    console.log("All office holidays already present — nothing to insert.");
    return;
  }

  const { error } = await supabase.from("calendar_events").insert(
    toInsert.map((h) => ({
      date: h.date,
      title: h.title,
      event_type: "holiday",
      holiday_pay_type: "paid",
      all_day: true,
      status: "active",
    })),
  );
  if (error) throw new Error(error.message);

  console.log(`Inserted ${toInsert.length} holiday(s):`);
  for (const h of toInsert) console.log(`  ${h.date}  ${h.title}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
