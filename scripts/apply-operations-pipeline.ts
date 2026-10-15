/**
 * Apply supabase/migrations/052_operations_pipeline.sql when a Postgres URL is available.
 * Does not print connection details.
 */
import "../src/loadEnvFile.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function alreadyApplied() {
  const users = await supabase.from("users").select("in_operations").limit(1);
  const operators = await supabase.from("enquiry_operators").select("enquiry_id").limit(1);
  const sends = await supabase.from("enquiry_agent_sends").select("id, contact_name, quoted_at").limit(1);
  const quotes = await supabase.from("quotation_vendor_quotes").select("logged_by").limit(1);
  const agents = await supabase.from("operations_agents").select("id").limit(1);
  const updates = await supabase.from("enquiry_updates").select("id").limit(1);
  const missing = [
    users.error && "users.in_operations",
    operators.error && "enquiry_operators",
    sends.error && "enquiry_agent_sends",
    quotes.error && "quotation_vendor_quotes.logged_by",
    agents.error && "operations_agents",
    updates.error && "enquiry_updates",
  ].filter(Boolean);
  return missing.length ? missing.join(", ") : "";
}

async function main() {
  const missing = await alreadyApplied();
  if (!missing) {
    const flagged = await supabase.from("users").select("full_name").eq("in_operations", true);
    const names = (flagged.data || []).map((row) => row.full_name).filter(Boolean).join(", ") || "none";
    console.log(`Operations pipeline tables are available. Flagged: ${names}`);
    return;
  }

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.DIRECT_URL;
  if (!dbUrl) {
    console.error("The operations tables are not in the database yet, and no DATABASE_URL is set.");
    console.error("Run supabase/migrations/052_operations_pipeline.sql and 053_operations_demo.sql in the Supabase SQL editor, then reload the pipeline.");
    process.exit(1);
  }

  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
  const sql = ["052_operations_pipeline.sql", "053_operations_demo.sql"]
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
  console.log("Applied operations pipeline migration.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/cannot find module/i.test(message)) {
    console.error("The operations tables are not in the database yet. Run supabase/migrations/052_operations_pipeline.sql and 053_operations_demo.sql in the Supabase SQL editor.");
    process.exit(1);
  }
  console.error(message.replace(/postgres:\/\/\S+/gi, "postgres://***"));
  process.exit(1);
});
