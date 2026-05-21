export type QuotationPrice = {
  amount: number;
  currency: string;
  notes: string | null;
};

/** Customer-facing price: revised price takes precedence over finalized send price. */
export function getQuotationCustomerPrice(q: {
  revised_price?: number | null;
  revised_currency?: string | null;
  revised_notes?: string | null;
  clarusto_final_price?: number | null;
  clarusto_final_currency?: string | null;
  clarusto_final_notes?: string | null;
}): QuotationPrice | null {
  if (q.revised_price != null && !Number.isNaN(Number(q.revised_price))) {
    return {
      amount: Number(q.revised_price),
      currency: (q.revised_currency || "INR").toUpperCase(),
      notes: q.revised_notes?.trim() || null,
    };
  }
  if (q.clarusto_final_price != null && !Number.isNaN(Number(q.clarusto_final_price))) {
    return {
      amount: Number(q.clarusto_final_price),
      currency: (q.clarusto_final_currency || "INR").toUpperCase(),
      notes: q.clarusto_final_notes?.trim() || null,
    };
  }
  return null;
}
