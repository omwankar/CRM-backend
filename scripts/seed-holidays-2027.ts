/**
 * Seed the 2027 company holiday list (paid) into calendar_events.
 * Idempotent — skips dates that already have a holiday.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-holidays-2027.ts
 */
import "../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const HOLIDAYS: Array<{ date: string; title: string }> = [
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
    .gte("date", "2027-01-01")
    .lte("date", "2027-12-31");
  if (readErr) throw new Error(readErr.message);

  const have = new Set((existing || []).map((r: { date: string }) => String(r.date).slice(0, 10)));
  const toInsert = HOLIDAYS.filter((h) => !have.has(h.date));

  if (!toInsert.length) {
    console.log("2027 holidays already present — nothing to insert.");
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

  console.log(`Inserted ${toInsert.length} holiday(s) for 2027:`);
  for (const h of toInsert) console.log(`  ${h.date}  ${h.title}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
