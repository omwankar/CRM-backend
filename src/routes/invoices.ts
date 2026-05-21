import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { sharedWriteGuard } from "../middleware/requireRole.js";
import { generateNextInvoiceNumber, computeInvoiceTotals } from "../utils/invoiceNumber.js";
import { buildInvoicePdfBuffer, resolveInvoiceLogoPath, type InvoicePdfData } from "../services/invoicePdf.js";
import { sendInvoiceEmail } from "../services/invoiceEmail.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const invoiceStatus = z.enum(["draft", "sent", "paid", "overdue", "cancelled"]);

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit_price: z.number().min(0),
});

const createSchema = z.object({
  buyer_id: z.string().uuid(),
  issue_date: z.string().optional(),
  due_date: z.string(),
  currency: z.string().min(3).max(3).default("INR"),
  tax_rate: z.number().min(0).max(100).default(0),
  notes: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  line_items: z.array(lineItemSchema).min(1),
});

const updateSchema = createSchema.partial().extend({
  status: invoiceStatus.optional(),
});

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

async function logActivity(userId: string, action: string, recordId?: string, details?: Record<string, unknown>) {
  await supabase.from("activity_logs").insert({
    user_id: userId,
    action,
    table_name: "invoices",
    record_id: recordId || null,
    details: details || null,
  });
}

function mapLineItems(lines: z.infer<typeof lineItemSchema>[]) {
  return lines.map((l, i) => ({
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    amount: Math.round(l.quantity * l.unit_price * 100) / 100,
    sort_order: i,
  }));
}

async function fetchInvoiceDetail(id: string) {
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !invoice) return null;

  const [{ data: lines }, { data: buyer }] = await Promise.all([
    supabase
      .from("invoice_line_items")
      .select("*")
      .eq("invoice_id", id)
      .order("sort_order", { ascending: true }),
    supabase.from("buyers").select("*").eq("id", invoice.buyer_id).is("deleted_at", null).maybeSingle(),
  ]);

  return { ...invoice, line_items: lines || [], buyer: buyer || null };
}

async function buildPdfForInvoice(detail: NonNullable<Awaited<ReturnType<typeof fetchInvoiceDetail>>>) {
  const pdfData: InvoicePdfData = {
    invoice_number: detail.invoice_number,
    issue_date: detail.issue_date,
    due_date: detail.due_date,
    currency: detail.currency,
    subtotal: Number(detail.subtotal),
    tax_rate: Number(detail.tax_rate),
    tax_amount: Number(detail.tax_amount),
    total: Number(detail.total),
    notes: detail.notes,
    terms: detail.terms,
    company_name: process.env.COMPANY_NAME?.trim() || "Company",
    company_address: process.env.COMPANY_ADDRESS?.trim() || "",
    company_phone: process.env.COMPANY_PHONE?.trim() || null,
    company_vat_number: process.env.COMPANY_VAT_NUMBER?.trim() || null,
    logo_path: resolveInvoiceLogoPath(),
    amount_paid: 0,
    buyer: {
      buyer_name: detail.buyer?.buyer_name || "Client",
      contact_person: detail.buyer?.contact_person,
      contact_email: detail.buyer?.contact_email,
      address: detail.buyer?.address,
      city: detail.buyer?.city,
      state: detail.buyer?.state,
      postal_code: detail.buyer?.postal_code,
      country: detail.buyer?.country,
    },
    line_items: (detail.line_items || []).map(
      (l: { description: string; quantity: number; unit_price: number; amount: number }) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        amount: Number(l.amount),
      }),
    ),
  };
  return buildInvoicePdfBuffer(pdfData);
}

async function uploadInvoicePdf(invoiceId: string, buffer: Buffer) {
  const bucket = process.env.INVOICE_STORAGE_BUCKET?.trim() || "documents";
  const path = `invoices/${invoiceId}.pdf`;

  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType: "application/pdf",
    upsert: true,
  });

  if (error) {
    return { pdf_url: null as string | null, pdf_path: null as string | null, storageError: error.message };
  }

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return { pdf_url: urlData.publicUrl, pdf_path: path, storageError: null as string | null };
}

// GET /api/invoices
router.get("/", async (req, res) => {
  const { status, buyer_id, search, page = "1", limit = "20" } = req.query;
  let query = supabase
    .from("invoices")
    .select("*, buyers(id, buyer_name, contact_email)", { count: "exact" })
    .is("deleted_at", null);

  if (status) query = query.eq("status", status as string);
  if (buyer_id) query = query.eq("buyer_id", buyer_id as string);
  if (search) {
    const s = String(search).trim();
    query = query.ilike("invoice_number", `%${s}%`);
  }

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order("created_at", { ascending: false });

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// POST /api/invoices
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { buyer_id, due_date, currency, tax_rate, notes, terms, line_items } = parsed.data;
  const issue_date = parsed.data.issue_date || new Date().toISOString().slice(0, 10);

  const { data: buyer, error: buyerErr } = await supabase
    .from("buyers")
    .select("id")
    .eq("id", buyer_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (buyerErr || !buyer) return res.status(400).json({ error: "Buyer not found" });

  const mapped = mapLineItems(line_items);
  const totals = computeInvoiceTotals(mapped, tax_rate);
  const invoice_number = await generateNextInvoiceNumber(supabase);
  const userId = req.user?.id;

  const { data: invoice, error: invErr } = await supabase
    .from("invoices")
    .insert({
      invoice_number,
      buyer_id,
      status: "draft",
      issue_date,
      due_date,
      currency: currency.toUpperCase(),
      tax_rate,
      notes: notes ?? null,
      terms: terms ?? null,
      created_by: userId,
      ...totals,
    })
    .select()
    .single();

  if (invErr || !invoice) return res.status(500).json({ error: invErr?.message || "Failed to create invoice" });

  const rows = mapped.map((l) => ({ ...l, invoice_id: invoice.id }));
  const { error: linesErr } = await supabase.from("invoice_line_items").insert(rows);
  if (linesErr) {
    await supabase.from("invoices").delete().eq("id", invoice.id);
    return res.status(500).json({ error: linesErr.message });
  }

  if (userId) await logActivity(userId, "invoice_created", invoice.id, { invoice_number });
  const detail = await fetchInvoiceDetail(invoice.id);
  res.status(201).json(detail);
});

// GET /api/invoices/:id
router.get("/:id", async (req, res) => {
  const detail = await fetchInvoiceDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Invoice not found" });
  res.json(detail);
});

// GET /api/invoices/:id/pdf — download PDF (regenerate if needed)
router.get("/:id/pdf", async (req, res) => {
  const detail = await fetchInvoiceDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Invoice not found" });

  try {
    const buffer = await buildPdfForInvoice(detail);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${detail.invoice_number}.pdf"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "PDF generation failed" });
  }
});

// PUT /api/invoices/:id — draft only
router.put("/:id", async (req, res) => {
  const detail = await fetchInvoiceDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Invoice not found" });
  if (detail.status !== "draft") {
    return res.status(400).json({ error: "Only draft invoices can be edited" });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const payload = parsed.data;
  let totals = {
    subtotal: Number(detail.subtotal),
    tax_amount: Number(detail.tax_amount),
    total: Number(detail.total),
  };
  const tax_rate = payload.tax_rate ?? Number(detail.tax_rate);

  if (payload.line_items) {
    const mapped = mapLineItems(payload.line_items);
    totals = computeInvoiceTotals(mapped, tax_rate);
    await supabase.from("invoice_line_items").delete().eq("invoice_id", detail.id);
    await supabase.from("invoice_line_items").insert(mapped.map((l) => ({ ...l, invoice_id: detail.id })));
  } else if (payload.tax_rate != null) {
    const { data: existingLines } = await supabase
      .from("invoice_line_items")
      .select("quantity, unit_price")
      .eq("invoice_id", detail.id);
    totals = computeInvoiceTotals(
      (existingLines || []).map((l) => ({ quantity: Number(l.quantity), unit_price: Number(l.unit_price) })),
      tax_rate,
    );
  }

  const updateRow: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    tax_rate,
    ...totals,
    pdf_url: null,
    pdf_path: null,
  };

  if (payload.buyer_id) updateRow.buyer_id = payload.buyer_id;
  if (payload.issue_date) updateRow.issue_date = payload.issue_date;
  if (payload.due_date) updateRow.due_date = payload.due_date;
  if (payload.currency) updateRow.currency = payload.currency.toUpperCase();
  if (payload.notes !== undefined) updateRow.notes = payload.notes;
  if (payload.terms !== undefined) updateRow.terms = payload.terms;

  const { error } = await supabase.from("invoices").update(updateRow).eq("id", detail.id);
  if (error) return res.status(500).json({ error: error.message });

  const updated = await fetchInvoiceDetail(detail.id);
  res.json(updated);
});

// DELETE /api/invoices/:id — soft delete
router.delete("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("invoices")
    .update({ deleted_at: new Date().toISOString(), status: "cancelled" })
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Invoice not found" });
  res.json({ success: true });
});

// POST /api/invoices/:id/generate-pdf
router.post("/:id/generate-pdf", async (req, res) => {
  const detail = await fetchInvoiceDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Invoice not found" });

  try {
    const buffer = await buildPdfForInvoice(detail);
    const uploaded = await uploadInvoicePdf(detail.id, buffer);

    const { error } = await supabase
      .from("invoices")
      .update({
        pdf_url: uploaded.pdf_url,
        pdf_path: uploaded.pdf_path,
        updated_at: new Date().toISOString(),
      })
      .eq("id", detail.id);

    if (error) return res.status(500).json({ error: error.message });

    const updated = await fetchInvoiceDetail(detail.id);
    res.json({
      ...updated,
      storage_warning: uploaded.storageError || undefined,
      pdf_download_url: `/api/invoices/${detail.id}/pdf`,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "PDF generation failed" });
  }
});

const sendSchema = z.object({
  email: z.string().email().optional(),
});

// POST /api/invoices/:id/send
router.post("/:id/send", async (req, res) => {
  const detail = await fetchInvoiceDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Invoice not found" });
  if (detail.status === "cancelled") {
    return res.status(400).json({ error: "Cancelled invoices cannot be sent" });
  }

  const parsed = sendSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const toEmail = parsed.data.email?.trim() || detail.buyer?.contact_email?.trim();
  if (!toEmail) {
    return res.status(400).json({
      error: "Buyer has no contact email. Add an email on the buyer record or pass email in the request body.",
    });
  }

  try {
    const buffer = await buildPdfForInvoice(detail);
    const uploaded = await uploadInvoicePdf(detail.id, buffer);

    const emailResult = await sendInvoiceEmail({
      to: toEmail,
      invoiceNumber: detail.invoice_number,
      buyerName: detail.buyer?.buyer_name || "",
      total: Number(detail.total),
      currency: detail.currency,
      dueDate: detail.due_date,
      pdfBuffer: buffer,
      pdfFilename: `${detail.invoice_number}.pdf`,
    });

    const { error } = await supabase
      .from("invoices")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        sent_to_email: toEmail,
        email_message_id: emailResult.id,
        pdf_url: uploaded.pdf_url,
        pdf_path: uploaded.pdf_path,
        updated_at: new Date().toISOString(),
      })
      .eq("id", detail.id);

    if (error) return res.status(500).json({ error: error.message });

    const userId = req.user?.id;
    if (userId) {
      await logActivity(userId, "invoice_sent", detail.id, {
        invoice_number: detail.invoice_number,
        sent_to: toEmail,
      });
    }

    const updated = await fetchInvoiceDetail(detail.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to send invoice" });
  }
});

export function registerInvoiceRoutes(api: express.Router) {
  api.use("/invoices", router);
}
