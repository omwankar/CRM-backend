import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { sharedWriteGuard } from "../middleware/requireRole.js";
import {
  deriveInvoiceStatus,
  paymentFlags,
  sumPayments,
} from "../utils/invoicePaymentStatus.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const createSchema = z.object({
  invoice_id: z.string().uuid(),
  amount: z.number().positive(),
  payment_date: z.string().optional(),
  method: z.enum(["bank_transfer", "cheque", "cash", "card", "other"]),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function getInvoiceAmountPaid(invoiceId: string): Promise<number> {
  const { data } = await supabase
    .from("payments")
    .select("amount")
    .eq("invoice_id", invoiceId)
    .is("deleted_at", null);
  return sumPayments((data || []).map((p) => p.amount));
}

/** Sync stored status from payments (never touches draft/cancelled). */
export async function syncInvoiceStatusFromPayments(invoiceId: string) {
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, status, total, due_date")
    .eq("id", invoiceId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!inv) return null;
  if (inv.status === "draft" || inv.status === "cancelled") return inv;

  const amountPaid = await getInvoiceAmountPaid(invoiceId);
  const next = deriveInvoiceStatus({
    storedStatus: inv.status,
    total: Number(inv.total),
    amountPaid,
    dueDate: inv.due_date,
  });

  if (next !== inv.status) {
    const { data: updated } = await supabase
      .from("invoices")
      .update({ status: next })
      .eq("id", invoiceId)
      .select()
      .single();
    return updated || { ...inv, status: next };
  }
  return inv;
}

export async function enrichInvoiceWithPayments<T extends Record<string, any>>(invoice: T) {
  const amountPaid = await getInvoiceAmountPaid(invoice.id);
  const flags = paymentFlags(Number(invoice.total), amountPaid);
  const displayStatus = deriveInvoiceStatus({
    storedStatus: invoice.status,
    total: Number(invoice.total),
    amountPaid,
    dueDate: invoice.due_date,
  });

  // Keep DB in sync for overdue when reading (sent past due with no payments)
  if (
    invoice.status !== "draft" &&
    invoice.status !== "cancelled" &&
    displayStatus !== invoice.status
  ) {
    await supabase.from("invoices").update({ status: displayStatus }).eq("id", invoice.id);
  }

  return {
    ...invoice,
    status: displayStatus,
    ...flags,
  };
}

async function listPaymentsForInvoice(invoiceId: string) {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .is("deleted_at", null)
    .order("payment_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// GET /api/payments?invoice_id=
router.get("/", async (req, res) => {
  const invoiceId = String(req.query.invoice_id || "");
  if (!invoiceId) return res.status(400).json({ error: "invoice_id is required" });

  try {
    const data = await listPaymentsForInvoice(invoiceId);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load payments" });
  }
});

// GET /api/payments/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Payment not found" });
  res.json(data);
});

// POST /api/payments
router.post("/", sharedWriteGuard, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, status, total, currency, deleted_at")
    .eq("id", parsed.data.invoice_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (inv.status === "draft") {
    return res.status(400).json({ error: "Cannot record payment on a draft invoice — send it first" });
  }
  if (inv.status === "cancelled") {
    return res.status(400).json({ error: "Cannot record payment on a cancelled invoice" });
  }

  const { data, error } = await supabase
    .from("payments")
    .insert({
      invoice_id: parsed.data.invoice_id,
      amount: parsed.data.amount,
      currency: inv.currency,
      payment_date: parsed.data.payment_date || new Date().toISOString().slice(0, 10),
      method: parsed.data.method,
      reference: parsed.data.reference?.trim() || null,
      notes: parsed.data.notes?.trim() || null,
      recorded_by: req.user?.id || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const invoice = await syncInvoiceStatusFromPayments(parsed.data.invoice_id);
  const amountPaid = await getInvoiceAmountPaid(parsed.data.invoice_id);
  const flags = paymentFlags(Number(inv.total), amountPaid);

  res.status(201).json({
    payment: data,
    invoice: invoice
      ? {
          ...invoice,
          ...flags,
          status: deriveInvoiceStatus({
            storedStatus: invoice.status,
            total: Number(inv.total),
            amountPaid,
            dueDate: (invoice as any).due_date || null,
          }),
        }
      : null,
  });
});

// DELETE /api/payments/:id — soft delete
router.delete("/:id", sharedWriteGuard, async (req, res) => {
  const { data: existing, error: findErr } = await supabase
    .from("payments")
    .select("*")
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!existing) return res.status(404).json({ error: "Payment not found" });

  const { error } = await supabase
    .from("payments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  await syncInvoiceStatusFromPayments(existing.invoice_id);
  res.json({ success: true });
});

export function registerPaymentRoutes(api: express.Router) {
  api.use("/payments", router);
}
