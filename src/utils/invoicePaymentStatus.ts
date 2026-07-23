/**
 * Invoice payment totals + derived display status.
 * Stored status stays draft | sent | cancelled (manual) or is synced to
 * partial | paid | overdue after payment changes — never set paid/overdue via client PUT.
 */

export type InvoiceWorkflowStatus =
  | "draft"
  | "sent"
  | "partial"
  | "paid"
  | "overdue"
  | "cancelled";

export function sumPayments(amounts: Array<number | string | null | undefined>): number {
  const total = amounts.reduce((acc, a) => acc + Number(a || 0), 0);
  return Math.round(total * 100) / 100;
}

export function deriveInvoiceStatus(args: {
  storedStatus: string;
  total: number;
  amountPaid: number;
  dueDate: string | null | undefined;
  today?: Date;
}): InvoiceWorkflowStatus {
  const stored = args.storedStatus as InvoiceWorkflowStatus;
  if (stored === "draft" || stored === "cancelled") return stored;

  const total = Math.round(Number(args.total || 0) * 100) / 100;
  const paid = Math.round(Number(args.amountPaid || 0) * 100) / 100;

  if (total > 0 && paid >= total) return "paid";

  const today = args.today || new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const due = args.dueDate ? String(args.dueDate).slice(0, 10) : null;
  const isOverdue = Boolean(due && due < todayStr);

  if (paid > 0 && paid < total) {
    // Still partially paid; overdue takes badge priority when past due
    return isOverdue ? "overdue" : "partial";
  }

  if (isOverdue) return "overdue";
  return "sent";
}

export function paymentFlags(total: number, amountPaid: number) {
  const t = Math.round(Number(total || 0) * 100) / 100;
  const p = Math.round(Number(amountPaid || 0) * 100) / 100;
  const balance = Math.round((t - p) * 100) / 100;
  const overpaid = p > t && t >= 0;
  return {
    amount_paid: p,
    balance_due: Math.max(balance, 0),
    overpaid,
    overpayment_amount: overpaid ? Math.round((p - t) * 100) / 100 : 0,
  };
}
