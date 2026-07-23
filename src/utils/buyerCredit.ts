import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export type CreditWarning = {
  credit_warning: true;
  buyer_id: string;
  credit_limit: number | null;
  credit_used: number;
  credit_available: number | null;
  proposed_value: number;
  would_exceed_by: number;
  message: string;
};

export async function getBuyerCreditRow(buyerId: string) {
  const { data, error } = await supabase
    .from("buyer_credit_status")
    .select("*")
    .eq("buyer_id", buyerId)
    .maybeSingle();

  if (error) {
    // View may not exist yet — fall back to buyer only
    const { data: buyer } = await supabase
      .from("buyers")
      .select("id, buyer_name, credit_limit")
      .eq("id", buyerId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!buyer) return null;
    return {
      buyer_id: buyer.id,
      buyer_name: buyer.buyer_name,
      credit_limit: buyer.credit_limit != null ? Number(buyer.credit_limit) : null,
      credit_used: 0,
      credit_available: buyer.credit_limit != null ? Number(buyer.credit_limit) : null,
    };
  }
  if (!data) return null;
  return {
    buyer_id: data.buyer_id,
    buyer_name: data.buyer_name,
    credit_limit: data.credit_limit != null ? Number(data.credit_limit) : null,
    credit_used: Number(data.credit_used || 0),
    credit_available: data.credit_available != null ? Number(data.credit_available) : null,
  };
}

/** Soft warning when proposedValue would push used credit past limit. Not a hard block. */
export async function creditWarningIfExceeded(
  buyerId: string | null | undefined,
  proposedValue: number | null | undefined,
): Promise<CreditWarning | null> {
  if (!buyerId) return null;
  const value = Number(proposedValue);
  if (!Number.isFinite(value) || value <= 0) return null;

  const row = await getBuyerCreditRow(buyerId);
  if (!row || row.credit_limit == null) return null;

  const available = row.credit_available ?? row.credit_limit - row.credit_used;
  if (value <= available) return null;

  const exceedBy = Math.round((value - available) * 100) / 100;
  return {
    credit_warning: true,
    buyer_id: row.buyer_id,
    credit_limit: row.credit_limit,
    credit_used: row.credit_used,
    credit_available: available,
    proposed_value: value,
    would_exceed_by: exceedBy,
    message: `This would exceed the buyer's credit available (${available.toLocaleString()}). Limit ${row.credit_limit.toLocaleString()}, used ${row.credit_used.toLocaleString()}. Exceeds by ${exceedBy.toLocaleString()}.`,
  };
}
