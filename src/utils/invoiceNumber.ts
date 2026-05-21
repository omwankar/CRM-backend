import type { SupabaseClient } from "@supabase/supabase-js";

/** Generate next invoice number: INV-YYYY-0001 */
export async function generateNextInvoiceNumber(supabase: SupabaseClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;

  const { data } = await supabase
    .from("invoices")
    .select("invoice_number")
    .like("invoice_number", `${prefix}%`)
    .order("invoice_number", { ascending: false })
    .limit(1);

  let next = 1;
  if (data?.[0]?.invoice_number) {
    const tail = data[0].invoice_number.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (!Number.isNaN(n)) next = n + 1;
  }

  return `${prefix}${String(next).padStart(4, "0")}`;
}

export function computeInvoiceTotals(
  lines: { quantity: number; unit_price: number }[],
  taxRate: number,
) {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
  const tax_amount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
  const total = Math.round((subtotal + tax_amount) * 100) / 100;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax_amount,
    total,
  };
}
