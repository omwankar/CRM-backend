/**
 * Delete inquiries that belong to the Operations Pipeline module only.
 * Leaves CRM enquiries that were never put on the pipeline.
 */
import "../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function enquiryIds() {
  const flagged = await supabase.from("enquiries").select("id").eq("in_operations", true);
  if (!flagged.error) return (flagged.data || []).map((row) => row.id);
  const ops = await supabase.from("enquiry_operators").select("enquiry_id");
  return Array.from(new Set((ops.data || []).map((row) => row.enquiry_id)));
}

async function deleteOne(enquiryId: string) {
  const { data: quotes } = await supabase.from("quotations").select("id").eq("enquiry_id", enquiryId);
  const quoteIds = (quotes || []).map((row) => row.id);
  if (quoteIds.length) {
    await supabase.from("quotation_vendor_quotes").delete().in("quotation_id", quoteIds);
    await supabase.from("quotations").delete().in("id", quoteIds);
  }
  await supabase.from("enquiry_updates").delete().eq("enquiry_id", enquiryId);
  await supabase.from("enquiry_agent_sends").delete().eq("enquiry_id", enquiryId);
  await supabase.from("enquiry_operators").delete().eq("enquiry_id", enquiryId);
  const { error } = await supabase.from("enquiries").delete().eq("id", enquiryId);
  if (error) throw new Error(error.message);
}

async function main() {
  const ids = await enquiryIds();
  let deleted = 0;
  for (const id of ids) {
    await deleteOne(id);
    deleted += 1;
  }
  console.log(`Deleted ${deleted} operations pipeline inquir${deleted === 1 ? "y" : "ies"}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
