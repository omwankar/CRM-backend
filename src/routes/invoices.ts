import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { sharedWriteGuard } from "../middleware/requireRole.js";
import {
  generateNextInvoiceNumber,
  computeInvoiceTotalsFromTaxes,
  type DiscountInput,
  type InvoiceTaxInput,
} from "../utils/invoiceNumber.js";
import { buildInvoicePdfBuffer, resolveInvoiceLogoPath, type InvoicePdfData } from "../services/invoicePdf.js";
import { sendInvoiceEmail } from "../services/invoiceEmail.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const invoiceStatus = z.enum(["draft", "sent", "paid", "overdue", "cancelled"]);

const lineItemSchema = z.object({
  description: z.string().min(1),
  line_detail: z.string().optional().nullable(),
  quantity: z.number().positive(),
  unit_price: z.number().min(0),
});

const discountSchema = z
  .object({
    type: z.enum(["percent", "fixed"]),
    value: z.number().min(0),
  })
  .optional()
  .nullable();

const companySettingsSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  vat_number: z.string().optional().nullable(),
});

const COMPANY_SETTINGS_KEY = "invoice_company";

const taxSchema = z.object({
  rate: z.number().min(0).max(100),
  name: z.string().min(1),
  tax_number: z.string().optional().nullable(),
});

const createSchema = z.object({
  buyer_id: z.string().uuid(),
  issue_date: z.string().optional(),
  due_date: z.string(),
  currency: z.string().min(3).max(3).default("INR"),
  tax_rate: z.number().min(0).max(100).optional(),
  taxes: z.array(taxSchema).optional(),
  reference: z.string().optional().nullable(),
  discount: discountSchema,
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
    description: l.description.trim(),
    line_detail: l.line_detail?.trim() || null,
    quantity: l.quantity,
    unit_price: l.unit_price,
    amount: Math.round(l.quantity * l.unit_price * 100) / 100,
    sort_order: i,
  }));
}

function resolveDiscount(body: { discount?: DiscountInput }): DiscountInput {
  const d = body.discount;
  if (!d || d.value <= 0) return null;
  return d;
}

function companyFromEnv() {
  return {
    name: process.env.COMPANY_NAME?.trim() || "Company",
    phone: process.env.COMPANY_PHONE?.trim() || "",
    address: process.env.COMPANY_ADDRESS?.trim() || "",
    vat_number: process.env.COMPANY_VAT_NUMBER?.trim() || "",
  };
}

async function loadCompanySettings() {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", COMPANY_SETTINGS_KEY)
    .maybeSingle();
  if (data?.value && typeof data.value === "object") {
    const v = data.value as Record<string, string>;
    return {
      name: v.name || companyFromEnv().name,
      phone: v.phone ?? companyFromEnv().phone,
      address: v.address ?? companyFromEnv().address,
      vat_number: v.vat_number ?? companyFromEnv().vat_number,
    };
  }
  return companyFromEnv();
}

function resolveTaxInputs(body: { taxes?: InvoiceTaxInput[]; tax_rate?: number }): InvoiceTaxInput[] {
  if (body.taxes?.length) return body.taxes;
  if (body.tax_rate != null && body.tax_rate > 0) {
    return [{ rate: body.tax_rate, name: String(body.tax_rate) }];
  }
  return [];
}

async function saveInvoiceTaxes(
  invoiceId: string,
  taxes: Array<{ rate: number; name: string; tax_number?: string | null; amount: number; sort_order: number }>,
) {
  await supabase.from("invoice_taxes").delete().eq("invoice_id", invoiceId);
  if (taxes.length === 0) return;
  const { error } = await supabase.from("invoice_taxes").insert(
    taxes.map((t) => ({
      invoice_id: invoiceId,
      rate: t.rate,
      name: t.name,
      tax_number: t.tax_number ?? null,
      amount: t.amount,
      sort_order: t.sort_order,
    })),
  );
  if (error) throw new Error(error.message);
}

async function fetchInvoiceDetail(id: string) {
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !invoice) return null;

  const [{ data: lines }, { data: buyer }, { data: taxes }] = await Promise.all([
    supabase
      .from("invoice_line_items")
      .select("*")
      .eq("invoice_id", id)
      .order("sort_order", { ascending: true }),
    supabase.from("buyers").select("*").eq("id", invoice.buyer_id).is("deleted_at", null).maybeSingle(),
    supabase
      .from("invoice_taxes")
      .select("*")
      .eq("invoice_id", id)
      .order("sort_order", { ascending: true }),
  ]);

  const taxRows = taxes?.length
    ? taxes
    : Number(invoice.tax_rate) > 0
      ? [
          {
            rate: invoice.tax_rate,
            name: String(invoice.tax_rate),
            tax_number: process.env.COMPANY_VAT_NUMBER?.trim() || null,
            amount: invoice.tax_amount,
            sort_order: 0,
          },
        ]
      : [];

  return { ...invoice, line_items: lines || [], buyer: buyer || null, taxes: taxRows };
}

async function buildPdfForInvoice(detail: NonNullable<Awaited<ReturnType<typeof fetchInvoiceDetail>>>) {
  const company = await loadCompanySettings();
  const pdfData: InvoicePdfData = {
    invoice_number: detail.invoice_number,
    issue_date: detail.issue_date,
    due_date: detail.due_date,
    currency: detail.currency,
    reference: detail.reference ?? null,
    subtotal: Number(detail.subtotal),
    discount_amount: Number(detail.discount_amount ?? 0),
    tax_rate: Number(detail.tax_rate),
    tax_amount: Number(detail.tax_amount),
    total: Number(detail.total),
    notes: detail.notes,
    terms: detail.terms,
    company_name: company.name,
    company_address: company.address,
    company_phone: company.phone || null,
    company_vat_number: company.vat_number || null,
    taxes: (detail.taxes || []).map(
      (t: { rate: number; name: string; tax_number?: string | null; amount: number }) => ({
        rate: Number(t.rate),
        name: t.name,
        tax_number: t.tax_number,
        amount: Number(t.amount),
      }),
    ),
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
      (l: {
        description: string;
        line_detail?: string | null;
        quantity: number;
        unit_price: number;
        amount: number;
      }) => ({
        description: l.description,
        subtext: l.line_detail,
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

// GET /api/invoices/settings/company
router.get("/settings/company", async (_req, res) => {
  try {
    res.json(await loadCompanySettings());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load company settings" });
  }
});

// PUT /api/invoices/settings/company
router.put("/settings/company", async (req, res) => {
  const parsed = companySettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }
  const value = {
    name: parsed.data.name,
    phone: parsed.data.phone?.trim() || "",
    address: parsed.data.address?.trim() || "",
    vat_number: parsed.data.vat_number?.trim() || "",
  };
  const { error } = await supabase.from("app_settings").upsert(
    { key: COMPANY_SETTINGS_KEY, value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json(value);
});

// POST /api/invoices
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { buyer_id, due_date, currency, notes, terms, line_items, reference } = parsed.data;
  const issue_date = parsed.data.issue_date || new Date().toISOString().slice(0, 10);
  const taxInputs = resolveTaxInputs(parsed.data);
  const discount = resolveDiscount(parsed.data);

  const { data: buyer, error: buyerErr } = await supabase
    .from("buyers")
    .select("id")
    .eq("id", buyer_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (buyerErr || !buyer) return res.status(400).json({ error: "Buyer not found" });

  const mapped = mapLineItems(line_items);
  const totals = computeInvoiceTotalsFromTaxes(mapped, taxInputs, discount);
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
      tax_rate: totals.tax_rate,
      reference: reference?.trim() || null,
      discount_type: discount?.type ?? null,
      discount_value: discount?.value ?? 0,
      discount_amount: totals.discount_amount,
      notes: notes ?? null,
      terms: terms ?? null,
      created_by: userId,
      subtotal: totals.subtotal,
      tax_amount: totals.tax_amount,
      total: totals.total,
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

  try {
    await saveInvoiceTaxes(invoice.id, totals.taxes);
  } catch (e) {
    await supabase.from("invoices").delete().eq("id", invoice.id);
    return res.status(500).json({ error: e instanceof Error ? e.message : "Failed to save taxes" });
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
  const discount =
    payload.discount !== undefined
      ? resolveDiscount({ discount: payload.discount })
      : detail.discount_type && Number(detail.discount_value) > 0
        ? { type: detail.discount_type as "percent" | "fixed", value: Number(detail.discount_value) }
        : null;

  let totals = computeInvoiceTotalsFromTaxes(
    (detail.line_items || []).map((l: { quantity: number; unit_price: number }) => ({
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
    })),
    (detail.taxes || []).map((t: { rate: number; name: string; tax_number?: string | null }) => ({
      rate: Number(t.rate),
      name: t.name,
      tax_number: t.tax_number,
    })),
    discount,
  );

  const taxInputs =
    payload.taxes != null
      ? payload.taxes
      : payload.tax_rate != null
        ? resolveTaxInputs({ tax_rate: payload.tax_rate })
        : null;

  if (payload.line_items) {
    const mapped = mapLineItems(payload.line_items);
    const inputs =
      taxInputs ??
      resolveTaxInputs({
        taxes: (detail.taxes || []).map((t: { rate: number; name: string; tax_number?: string | null }) => ({
          rate: Number(t.rate),
          name: t.name,
          tax_number: t.tax_number,
        })),
      });
    totals = computeInvoiceTotalsFromTaxes(mapped, inputs, discount);
    await supabase.from("invoice_line_items").delete().eq("invoice_id", detail.id);
    await supabase.from("invoice_line_items").insert(mapped.map((l) => ({ ...l, invoice_id: detail.id })));
    try {
      await saveInvoiceTaxes(detail.id, totals.taxes);
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : "Failed to save taxes" });
    }
  } else if (taxInputs != null || payload.discount !== undefined) {
    const { data: existingLines } = await supabase
      .from("invoice_line_items")
      .select("quantity, unit_price")
      .eq("invoice_id", detail.id);
    const inputs =
      taxInputs ??
      resolveTaxInputs({
        taxes: (detail.taxes || []).map((t: { rate: number; name: string; tax_number?: string | null }) => ({
          rate: Number(t.rate),
          name: t.name,
          tax_number: t.tax_number,
        })),
      });
    totals = computeInvoiceTotalsFromTaxes(
      (existingLines || []).map((l) => ({ quantity: Number(l.quantity), unit_price: Number(l.unit_price) })),
      inputs,
      discount,
    );
    try {
      await saveInvoiceTaxes(detail.id, totals.taxes);
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : "Failed to save taxes" });
    }
  }

  const updateRow: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    tax_rate: totals.tax_rate ?? Number(detail.tax_rate),
    subtotal: totals.subtotal,
    discount_type: discount?.type ?? null,
    discount_value: discount?.value ?? 0,
    discount_amount: totals.discount_amount,
    tax_amount: totals.tax_amount,
    total: totals.total,
    pdf_url: null,
    pdf_path: null,
  };

  if (payload.buyer_id) updateRow.buyer_id = payload.buyer_id;
  if (payload.issue_date) updateRow.issue_date = payload.issue_date;
  if (payload.due_date) updateRow.due_date = payload.due_date;
  if (payload.currency) updateRow.currency = payload.currency.toUpperCase();
  if (payload.reference !== undefined) updateRow.reference = payload.reference?.trim() || null;
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
