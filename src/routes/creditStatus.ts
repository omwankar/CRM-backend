import express from "express";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { requireManager } from "../middleware/requireRole.js";
import { getBuyerCreditRow } from "../utils/buyerCredit.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

/** Open invoices contributing to credit used for one buyer */
async function openInvoicesForBuyer(buyerId: string) {
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, total, currency, due_date, issue_date")
    .eq("buyer_id", buyerId)
    .is("deleted_at", null)
    .neq("status", "cancelled")
    .order("due_date", { ascending: true });

  if (!invoices?.length) return [];

  const ids = invoices.map((i) => i.id);
  const { data: payments } = await supabase
    .from("payments")
    .select("invoice_id, amount")
    .in("invoice_id", ids)
    .is("deleted_at", null);

  const paidByInv: Record<string, number> = {};
  for (const p of payments || []) {
    paidByInv[p.invoice_id] = (paidByInv[p.invoice_id] || 0) + Number(p.amount || 0);
  }

  return invoices
    .map((i) => {
      const paid = Math.round((paidByInv[i.id] || 0) * 100) / 100;
      const total = Number(i.total || 0);
      const balance = Math.round((total - paid) * 100) / 100;
      return {
        ...i,
        amount_paid: paid,
        balance_due: Math.max(balance, 0),
      };
    })
    .filter((i) => i.balance_due > 0);
}

// GET /api/credit-status — list (manager+)
router.get("/credit-status", requireManager, async (_req, res) => {
  const { data, error } = await supabase.from("buyer_credit_status").select("*");
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data || [])
    .map((r) => {
      const limit = r.credit_limit != null ? Number(r.credit_limit) : null;
      const used = Number(r.credit_used || 0);
      const available = r.credit_available != null ? Number(r.credit_available) : null;
      const utilization =
        limit != null && limit > 0 ? Math.round((used / limit) * 10000) / 100 : null;
      return {
        buyer_id: r.buyer_id,
        buyer_name: r.buyer_name,
        credit_limit: limit,
        credit_used: used,
        credit_available: available,
        utilization_pct: utilization,
      };
    })
    .sort((a, b) => (b.utilization_pct ?? -1) - (a.utilization_pct ?? -1));

  res.json({ data: rows });
});

export function registerCreditStatusRoutes(api: express.Router) {
  api.use(router);
}

/** Mount under buyers — registered after auth on buyers router */
export function registerBuyerCreditRoute(buyersRouter: express.Router) {
  buyersRouter.get("/:id/credit-status", async (req, res) => {
    const buyerId = req.params.id;
    const row = await getBuyerCreditRow(buyerId);
    if (!row) return res.status(404).json({ error: "Buyer not found" });

    const open_invoices = await openInvoicesForBuyer(buyerId);
    const limit = row.credit_limit;
    const used = row.credit_used;
    const utilization =
      limit != null && limit > 0 ? Math.round((used / limit) * 10000) / 100 : null;

    res.json({
      ...row,
      utilization_pct: utilization,
      open_invoices,
    });
  });
}
