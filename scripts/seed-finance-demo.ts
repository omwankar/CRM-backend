/**
 * Seed Clarusto Finance demo data (invoices + payments + credit limits).
 *
 * Prefers buyers tagged [SEED-SALES]; otherwise creates [SEED-FINANCE] buyers.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-finance-demo.ts
 *   npx tsx scripts/seed-finance-demo.ts --clear
 */
import "./../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";
import { generateNextInvoiceNumber } from "../src/utils/invoiceNumber.js";

const CLEAR_ONLY = process.argv.includes("--clear");
const MARKER = "[SEED-FINANCE]";
const SALES_MARKER = "[SEED-SALES]";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysAgoDate(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function clearSeed() {
  console.log("Clearing previous Finance seed…");

  await sb.from("tasks").delete().ilike("notes", `%${MARKER}%`);

  const { data: invoices } = await sb
    .from("invoices")
    .select("id")
    .ilike("notes", `%${MARKER}%`);

  if (invoices?.length) {
    const ids = invoices.map((i) => i.id);
    await sb
      .from("payments")
      .update({ deleted_at: new Date().toISOString() })
      .in("invoice_id", ids)
      .is("deleted_at", null);
    await sb.from("invoice_line_items").delete().in("invoice_id", ids);
    await sb.from("invoice_taxes").delete().in("invoice_id", ids);
    await sb
      .from("invoices")
      .update({
        status: "cancelled",
        deleted_at: new Date().toISOString(),
        notes: `${MARKER} cleared`,
      })
      .in("id", ids);
  }

  // Soft-delete buyers created only by finance seed (not sales)
  const { data: finBuyers } = await sb
    .from("buyers")
    .select("id")
    .ilike("description", `%${MARKER}%`)
    .not("description", "ilike", `%${SALES_MARKER}%`);
  if (finBuyers?.length) {
    await sb
      .from("buyers")
      .update({ deleted_at: new Date().toISOString() })
      .in(
        "id",
        finBuyers.map((b) => b.id),
      );
  }

  console.log("Clear done.");
}

async function ensureBuyers(ownerId: string) {
  const { data: salesBuyers } = await sb
    .from("buyers")
    .select("id, buyer_name, credit_limit")
    .ilike("description", `%${SALES_MARKER}%`)
    .is("deleted_at", null);

  if (salesBuyers?.length) {
    const limits: Record<string, number> = {
      "Red Sea Freight Co": 250000,
      "Gulf Petrochem Trading": 500000,
      "Horizon Retail Group": 150000,
    };
    for (const b of salesBuyers) {
      const lim = limits[b.buyer_name];
      if (lim != null && (b.credit_limit == null || Number(b.credit_limit) === 0)) {
        await sb.from("buyers").update({ credit_limit: lim }).eq("id", b.id);
      }
    }
    const { data: refreshed } = await sb
      .from("buyers")
      .select("id, buyer_name, credit_limit")
      .ilike("description", `%${SALES_MARKER}%`)
      .is("deleted_at", null);
    return refreshed || salesBuyers;
  }

  console.log("No sales-seed buyers found — creating finance buyers…");
  const rows = [
    {
      buyer_name: "Oasis Importers KSA",
      contact_person: "Layla Mansour",
      contact_email: "layla@oasis-importers.example",
      city: "Jeddah",
      country: "Saudi Arabia",
      credit_limit: 200000,
      description: `${MARKER} Finance demo buyer`,
      created_by: ownerId,
    },
    {
      buyer_name: "Coastal Trading LLC",
      contact_person: "James Okonkwo",
      contact_email: "james@coastal.example",
      city: "Dubai",
      country: "UAE",
      credit_limit: 350000,
      description: `${MARKER} Finance demo buyer`,
      created_by: ownerId,
    },
    {
      buyer_name: "Metro Distributors",
      contact_person: "Aisha Rahman",
      contact_email: "aisha@metro.example",
      city: "Riyadh",
      country: "Saudi Arabia",
      credit_limit: 100000,
      description: `${MARKER} Finance demo buyer`,
      created_by: ownerId,
    },
  ];
  const { data, error } = await sb.from("buyers").insert(rows).select("id, buyer_name, credit_limit");
  if (error || !data?.length) throw new Error(`finance buyers: ${error?.message}`);
  return data;
}

async function createInvoice(args: {
  buyerId: string;
  ownerId: string;
  status: "draft" | "sent" | "partial" | "paid" | "overdue";
  issueOffset: number;
  dueOffset: number;
  description: string;
  quantity: number;
  unitPrice: number;
  currency?: string;
  payments?: Array<{ amount: number; daysAgo: number; method: string }>;
}) {
  const currency = args.currency || "SAR";
  const qty = args.quantity;
  const price = args.unitPrice;
  const subtotal = Math.round(qty * price * 100) / 100;
  const taxRate = 15;
  const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  const invoice_number = await generateNextInvoiceNumber(sb);
  const issue_date = daysAgoDate(args.issueOffset);
  const due_date = daysFromNow(args.dueOffset);
  // overdue: force past due date regardless of dueOffset
  const finalDue =
    args.status === "overdue" ? daysAgoDate(Math.abs(args.dueOffset) || 5) : due_date;

  const { data: inv, error } = await sb
    .from("invoices")
    .insert({
      invoice_number,
      buyer_id: args.buyerId,
      status: args.status === "overdue" || args.status === "partial" || args.status === "paid"
        ? args.status
        : args.status,
      issue_date,
      due_date: finalDue,
      currency,
      tax_rate: taxRate,
      subtotal,
      tax_amount: taxAmount,
      total,
      discount_amount: 0,
      notes: `${MARKER} ${args.description}`,
      terms: "Net 30",
      created_by: args.ownerId,
      sent_at: args.status === "draft" ? null : new Date().toISOString(),
      sent_to_email: args.status === "draft" ? null : "billing@example.com",
    })
    .select("id, invoice_number, total, currency, status")
    .single();

  if (error || !inv) throw new Error(`invoice ${invoice_number}: ${error?.message}`);

  const { error: lineErr } = await sb.from("invoice_line_items").insert({
    invoice_id: inv.id,
    description: args.description,
    quantity: qty,
    unit_price: price,
    amount: subtotal,
    sort_order: 0,
  });
  if (lineErr) throw new Error(`line items ${inv.invoice_number}: ${lineErr.message}`);

  // Optional tax row if table exists
  await sb.from("invoice_taxes").insert({
    invoice_id: inv.id,
    name: "VAT",
    rate: taxRate,
    amount: taxAmount,
    sort_order: 0,
  });

  for (const p of args.payments || []) {
    const payDate = daysAgoDate(p.daysAgo);
    const { error: pErr } = await sb.from("payments").insert({
      invoice_id: inv.id,
      amount: p.amount,
      currency: inv.currency,
      payment_date: payDate,
      method: p.method,
      reference: `${MARKER}-PAY`,
      notes: `${MARKER} Demo payment`,
      recorded_by: args.ownerId,
    });
    if (pErr) throw new Error(`payment on ${inv.invoice_number}: ${pErr.message}`);
  }

  return inv;
}

async function main() {
  const { data: users, error: uErr } = await sb
    .from("users")
    .select("id, full_name, email, role")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(3);

  if (uErr || !users?.length) {
    console.error("Need at least one active user:", uErr?.message);
    process.exit(1);
  }

  const owner = users[0].id;
  console.log(`Finance seed owner: ${users[0].full_name || users[0].email}`);

  await clearSeed();
  if (CLEAR_ONLY) {
    console.log("Cleared only. Exiting.");
    return;
  }

  const buyers = await ensureBuyers(owner);
  const byName = Object.fromEntries(buyers.map((b) => [b.buyer_name, b]));
  const pick = (...names: string[]) => {
    for (const n of names) if (byName[n]) return byName[n];
    return buyers[0];
  };

  const b1 = pick("Red Sea Freight Co", "Oasis Importers KSA");
  const b2 = pick("Gulf Petrochem Trading", "Coastal Trading LLC");
  const b3 = pick("Horizon Retail Group", "Metro Distributors");

  console.log(`Using buyers: ${buyers.map((b) => b.buyer_name).join(", ")}`);

  // Draft
  await createInvoice({
    buyerId: b1.id,
    ownerId: owner,
    status: "draft",
    issueOffset: 0,
    dueOffset: 30,
    description: "Draft freight charges — Jeddah inbound",
    quantity: 1,
    unitPrice: 12000,
  });

  // Sent (open — uses credit)
  const sent = await createInvoice({
    buyerId: b1.id,
    ownerId: owner,
    status: "sent",
    issueOffset: 3,
    dueOffset: 20,
    description: "Ocean freight FCL — Jeddah to Dammam",
    quantity: 2,
    unitPrice: 18500,
  });

  // Partial payment
  const partialTotal = Math.round(1 * 42000 * 1.15 * 100) / 100;
  await createInvoice({
    buyerId: b2.id,
    ownerId: owner,
    status: "partial",
    issueOffset: 10,
    dueOffset: 15,
    description: "Chemical tanker handling + docs",
    quantity: 1,
    unitPrice: 42000,
    payments: [
      {
        amount: Math.round(partialTotal * 0.4 * 100) / 100,
        daysAgo: 4,
        method: "bank_transfer",
      },
    ],
  });

  // Fully paid
  const paidTotal = Math.round(3 * 8500 * 1.15 * 100) / 100;
  await createInvoice({
    buyerId: b3.id,
    ownerId: owner,
    status: "paid",
    issueOffset: 25,
    dueOffset: -5,
    description: "Retail distribution last-mile — Riyadh",
    quantity: 3,
    unitPrice: 8500,
    payments: [
      { amount: paidTotal, daysAgo: 8, method: "bank_transfer" },
    ],
  });

  // Overdue unpaid (uses credit)
  await createInvoice({
    buyerId: b3.id,
    ownerId: owner,
    status: "overdue",
    issueOffset: 40,
    dueOffset: 12,
    description: "Overdue warehouse storage — Q2",
    quantity: 1,
    unitPrice: 27500,
  });

  // Second open invoice for high utilization on Horizon / Metro
  await createInvoice({
    buyerId: b3.id,
    ownerId: owner,
    status: "sent",
    issueOffset: 2,
    dueOffset: 25,
    description: "Cross-dock fees — multi-branch",
    quantity: 1,
    unitPrice: 55000,
  });

  // Finance task linked to sent invoice
  await sb.from("tasks").insert({
    task_title: `Chase payment ${sent.invoice_number}`,
    notes: `${MARKER} Follow up with buyer on open balance`,
    status: "Pending",
    priority: "high",
    task_type: "admin",
    entity_type: "invoice",
    entity_id: sent.id,
    assigned_person_id: owner,
    created_by: owner,
    assigned_date: daysFromNow(0),
    due_date: daysFromNow(3),
  });

  console.log("\nFinance seed complete.");
  console.log("  Invoices: draft, sent, partial, paid, overdue (+ extra open)");
  console.log("  Credit limits set on demo buyers — check Finance → Credit status");
  console.log("  Clear with: npx tsx scripts/seed-finance-demo.ts --clear");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
