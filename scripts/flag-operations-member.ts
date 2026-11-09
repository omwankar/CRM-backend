/**
 * Flag a CRM user as operations-team so they appear on the pipeline.
 * Usage: npx tsx scripts/flag-operations-member.ts amaldas@clarustologistics.com
 */
import "../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Pass a user email, e.g. npx tsx scripts/flag-operations-member.ts amaldas@clarustologistics.com");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const { data, error } = await supabase
  .from("users")
  .update({ in_operations: true })
  .ilike("email", email)
  .select("id, full_name, email, in_operations, is_active");

if (error) {
  console.error(error.message);
  process.exit(1);
}
if (!data?.length) {
  console.error(`No users row matched ${email}.`);
  process.exit(1);
}

for (const row of data) {
  console.log(`Flagged ${row.full_name} <${row.email}> in_operations=${row.in_operations} is_active=${row.is_active}`);
}
