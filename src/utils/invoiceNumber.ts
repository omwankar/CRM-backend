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

export type InvoiceTaxInput = {
  rate: number;
  name: string;
  tax_number?: string | null;
};

export type DiscountInput = {
  type: "percent" | "fixed";
  value: number;
} | null;

export type ComputedInvoiceTax = InvoiceTaxInput & {
  amount: number;
  sort_order: number;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function computeDiscountAmount(subtotal: number, discount: DiscountInput): number {
  if (!discount || discount.value <= 0 || subtotal <= 0) return 0;
  if (discount.type === "percent") {
    return round2(subtotal * (Math.min(100, discount.value) / 100));
  }
  return round2(Math.min(discount.value, subtotal));
}

export function computeInvoiceTotals(
  lines: { quantity: number; unit_price: number }[],
  taxRate: number,
  discount: DiscountInput = null,
) {
  const taxes: InvoiceTaxInput[] =
    taxRate > 0 ? [{ rate: taxRate, name: String(taxRate) }] : [];
  return computeInvoiceTotalsFromTaxes(lines, taxes, discount);
}

export function computeInvoiceTotalsFromTaxes(
  lines: { quantity: number; unit_price: number }[],
  taxes: InvoiceTaxInput[],
  discount: DiscountInput = null,
) {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0));
  const discount_amount = computeDiscountAmount(subtotal, discount);
  const taxable = round2(Math.max(0, subtotal - discount_amount));

  const computedTaxes: ComputedInvoiceTax[] = taxes
    .filter((t) => t.rate > 0)
    .map((t, i) => ({
      ...t,
      name: t.name?.trim() || String(t.rate),
      tax_number: t.tax_number?.trim() || null,
      amount: round2(taxable * (t.rate / 100)),
      sort_order: i,
    }));

  const tax_amount = round2(computedTaxes.reduce((s, t) => s + t.amount, 0));
  const total = round2(taxable + tax_amount);
  const tax_rate =
    computedTaxes.length === 1 ? computedTaxes[0].rate : computedTaxes.length > 0 ? computedTaxes[0].rate : 0;

  return {
    subtotal,
    discount_amount,
    tax_amount,
    total,
    tax_rate,
    taxes: computedTaxes,
  };
}
