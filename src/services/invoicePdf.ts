import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGO_PATH = path.join(__dirname, "../../assets/clarusto-logo.png");

/** Resolve logo file for PDF header (env INVOICE_LOGO_PATH or backend/assets/clarusto-logo.png). */
export function resolveInvoiceLogoPath(): string | null {
  const custom = process.env.INVOICE_LOGO_PATH?.trim();
  const candidate = custom ? path.resolve(custom) : DEFAULT_LOGO_PATH;
  return fs.existsSync(candidate) ? candidate : null;
}

export type InvoicePdfBuyer = {
  buyer_name: string;
  contact_person?: string | null;
  contact_email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

export type InvoicePdfLine = {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  /** e.g. "AT ACTUAL" — shown under description */
  subtext?: string | null;
  /** true → show "+{tax_rate}%" under Unit price column */
  vat_applicable?: boolean;
};

export type InvoicePdfTax = {
  rate: number;
  name: string;
  tax_number?: string | null;
  amount: number;
};

export type InvoicePdfData = {
  invoice_number: string;
  issue_date: string;
  due_date: string;
  currency: string;
  reference?: string | null;
  subtotal: number;
  discount_amount?: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  amount_paid?: number;
  notes?: string | null;
  terms?: string | null;
  buyer: InvoicePdfBuyer;
  line_items: InvoicePdfLine[];
  taxes?: InvoicePdfTax[];
  company_name: string;
  company_address: string;
  company_phone?: string | null;
  company_vat_number?: string | null;
  logo_path?: string | null;
};

function taxRowLabel(tax: InvoicePdfTax): string {
  const name = tax.name?.trim() || String(tax.rate);
  return `${tax.rate}% (${name})`;
}

const MARGIN = 54;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - MARGIN * 2;

const C_TEXT = "#333333";
const C_MUTED = "#999999";
const C_BORDER = "#e0e0e0";
const C_LABEL = "#7fa9c9";

const FS_LABEL = 9;
const FS_BODY = 10;
const FS_TABLE = 9;
const FS_AMOUNT_DUE = 18;

function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSAR(n: number): string {
  return `${fmtNum(n)}\u0631.\u0633`;
}

/** PDF-safe amounts — Helvetica lacks ₹, €, etc.; currency is shown in column labels. */
function fmtTableAmount(n: number, currency: string): string {
  if (currency === "SAR") return fmtSAR(n);
  return fmtNum(n);
}

function fmtTotals(n: number, _currency: string): string {
  return fmtNum(n);
}

function fmtDue(n: number, currency: string): string {
  if (currency === "SAR") return fmtSAR(n);
  return fmtTableAmount(n, currency);
}

function displayInvNo(raw: string): string {
  if (process.env.INVOICE_PDF_FULL_NUMBER === "1") return raw;
  const parts = raw.split("-");
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last) && parts.length >= 2) return last.padStart(7, "0").slice(-7);
  const digits = raw.replace(/\D/g, "");
  return digits ? digits.padStart(7, "0").slice(-7) : raw.replace(/^INV-/i, "");
}

function splitLines(s: string): string[] {
  return (s || "")
    .split(/\n|\|/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function buyerLines(b: InvoicePdfBuyer): string[] {
  const out: string[] = [];
  if (b.buyer_name?.trim()) out.push(b.buyer_name.trim());
  if (b.contact_person?.trim() && b.contact_person.trim() !== b.buyer_name?.trim()) {
    out.push(b.contact_person.trim());
  }
  if (b.address?.trim()) out.push(b.address.trim());
  const city = [b.city, b.state, b.postal_code].filter(Boolean).join(", ");
  if (city) out.push(city);
  if (b.country?.trim()) out.push(b.country.trim());
  return out.length ? out : ["—"];
}

function parseDesc(
  raw: string,
  subtext?: string | null
): { title: string; subtexts: string[] } {
  if (subtext) return { title: raw, subtexts: [subtext] };
  const pipe = raw.split("|").map((p) => p.trim()).filter(Boolean);
  if (pipe.length >= 2) return { title: pipe[0], subtexts: pipe.slice(1) };
  const nl = raw.split("\n").map((p) => p.trim()).filter(Boolean);
  if (nl.length >= 2) return { title: nl[0], subtexts: nl.slice(1) };
  return { title: raw.trim() || "—", subtexts: [] };
}

/** Split description subtexts vs rate-column VAT marker (+15%) */
function parseLineItem(
  item: InvoicePdfLine,
  taxRate: number
): { title: string; subtexts: string[]; rateSubtexts: string[] } {
  const { title, subtexts: rawSub } = parseDesc(item.description, item.subtext);
  const descSub: string[] = [];
  const rateSub: string[] = [];

  for (const s of rawSub) {
    if (/^\+?\d+(\.\d+)?%$/.test(s)) {
      rateSub.push(s.startsWith("+") ? s : `+${s}`);
    } else {
      descSub.push(s);
    }
  }

  if (item.vat_applicable) {
    const pct = taxRate > 0 ? taxRate : 15;
    const marker = `+${pct}%`;
    if (!rateSub.includes(marker)) rateSub.push(marker);
  }

  return { title, subtexts: descSub, rateSubtexts: rateSub };
}

export function buildInvoicePdfBuffer(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4", bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const amountPaid = data.amount_paid ?? 0;
    const amountDue = Math.max(0, data.total - amountPaid);
    const logoPath = data.logo_path ?? resolveInvoiceLogoPath();
    const currency = data.currency;

    const companyName =
      data.company_name && data.company_name !== "Company"
        ? data.company_name
        : process.env.COMPANY_NAME?.trim() || data.company_name;

    const hline = (y: number, color = C_BORDER, lw = 0.75) => {
      doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(color).lineWidth(lw).stroke();
    };

    const drawLabel = (x: number, y: number, w: number, text: string, align: "left" | "right" = "left") => {
      doc.font("Helvetica").fontSize(FS_LABEL).fillColor(C_LABEL);
      doc.text(text, x, y, { width: w, align });
      return doc.y + 3;
    };

    const drawValue = (
      x: number,
      y: number,
      w: number,
      lines: string[],
      opts: { bold?: boolean; size?: number; align?: "left" | "right" } = {}
    ) => {
      doc
        .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts.size ?? FS_BODY)
        .fillColor(C_TEXT);
      let vy = y;
      for (const line of lines) {
        doc.text(line, x, vy, { width: w, align: opts.align ?? "left", lineGap: 1 });
        vy = doc.y + 3;
      }
      return vy;
    };

    const drawTableHeader = (y: number) => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(C_LABEL);
      doc.text("Description", TC.desc, y, { width: TW.desc });
      doc.text("Quantity", TC.qty, y, { width: TW.qty, align: "right" });
      doc.text("Unit price", TC.unit, y, { width: TW.unit, align: "right" });
      doc.text("Line Total", TC.total, y, { width: TW.total, align: "right" });
      return y + 18;
    };

    // ── Logo (top-left) ─────────────────────────────────────────────────────
    let headerBottom = MARGIN;
    if (logoPath && fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, MARGIN, MARGIN, { width: 168 });
        headerBottom = MARGIN + 60;
      } catch {
        /* unreadable logo */
      }
    }

    // ── Company info (top-right) ────────────────────────────────────────────
    const coW = CONTENT_W * 0.46;
    const coX = MARGIN + CONTENT_W - coW;
    let cy = MARGIN + 2;

    doc.font("Helvetica-Bold").fontSize(FS_BODY).fillColor(C_TEXT);
    doc.text(companyName, coX, cy, { width: coW, align: "right" });
    cy = doc.y + 3;

    if (data.company_phone) {
      doc.font("Helvetica").fontSize(FS_BODY).fillColor(C_TEXT);
      doc.text(`Tel: ${data.company_phone}`, coX, cy, { width: coW, align: "right" });
      cy = doc.y + 3;
    }

    const addrLines = splitLines(data.company_address);
    if (addrLines.length === 0 && companyName === "Company") {
      doc.fontSize(8).fillColor(C_MUTED);
      doc.text("Set COMPANY_NAME and COMPANY_ADDRESS in backend .env", coX, cy, {
        width: coW,
        align: "right",
      });
      cy = doc.y + 3;
    } else {
      for (const line of addrLines) {
        doc.font("Helvetica").fontSize(FS_BODY).fillColor(C_TEXT);
        doc.text(line, coX, cy, { width: coW, align: "right" });
        cy = doc.y + 3;
      }
    }
    headerBottom = Math.max(headerBottom, cy);

    // ── Detail row ────────────────────────────────────────────────────────────
    const detailsY = headerBottom + 26;
    const col1W = CONTENT_W * 0.38;
    const col2W = CONTENT_W * 0.17;
    const col3W = CONTENT_W * 0.19;
    const col4W = CONTENT_W - col1W - col2W - col3W;
    const col1X = MARGIN;
    const col2X = col1X + col1W;
    const col3X = col2X + col2W;
    const col4X = col3X + col3W;

    let b1 = drawLabel(col1X, detailsY, col1W, "Billed To");
    b1 = drawValue(col1X, b1, col1W, buyerLines(data.buyer));

    let b2 = drawLabel(col2X, detailsY, col2W, "Date of Issue");
    b2 = drawValue(col2X, b2, col2W, [fmtDate(data.issue_date)]);
    b2 = drawLabel(col2X, b2 + 8, col2W, "Due Date");
    b2 = drawValue(col2X, b2, col2W, [fmtDate(data.due_date)]);

    let b3 = drawLabel(col3X, detailsY, col3W, "Invoice Number", "right");
    b3 = drawValue(col3X, b3, col3W, [displayInvNo(data.invoice_number)], { align: "right" });
    if (data.reference?.trim()) {
      b3 = drawLabel(col3X, b3 + 6, col3W, "Reference", "right");
      b3 = drawValue(col3X, b3, col3W, [data.reference.trim()], { align: "right" });
    }

    let b4 = drawLabel(col4X, detailsY, col4W, `Amount Due (${currency})`, "right");
    b4 = drawValue(col4X, b4, col4W, [fmtDue(amountDue, currency)], {
      bold: true,
      size: FS_AMOUNT_DUE,
      align: "right",
    });

    const sectionBottom = Math.max(b1, b2, b3, b4);

    // ── Line-items table ──────────────────────────────────────────────────────
    let tableY = sectionBottom + 24;

    const TC = {
      desc: MARGIN,
      qty: MARGIN + 238,
      unit: MARGIN + 294,
      total: MARGIN + 398,
    };
    const TW = {
      desc: 225,
      qty: 50,
      unit: 98,
      total: CONTENT_W - 398,
    };

    hline(tableY);
    tableY += 8;
    tableY = drawTableHeader(tableY);
    hline(tableY - 4);

    for (const item of data.line_items) {
      const { title, subtexts, rateSubtexts } = parseLineItem(item, data.tax_rate);
      const totalSubRows = Math.max(subtexts.length, rateSubtexts.length);
      const rowH = 22 + totalSubRows * 12;

      if (tableY + rowH > PAGE_H - 120) {
        doc.addPage();
        tableY = MARGIN + 20;
        hline(tableY);
        tableY += 8;
        tableY = drawTableHeader(tableY);
        hline(tableY - 4);
      }

      const ry = tableY + 6;

      doc.font("Helvetica").fontSize(FS_TABLE).fillColor(C_TEXT);
      doc.text(title, TC.desc, ry, { width: TW.desc });

      let subY = ry + 12;
      for (const sub of subtexts) {
        doc.font("Helvetica").fontSize(8).fillColor(C_MUTED);
        doc.text(sub, TC.desc, subY, { width: TW.desc });
        subY += 11;
      }

      doc.font("Helvetica").fontSize(FS_TABLE).fillColor(C_TEXT);
      doc.text(String(item.quantity), TC.qty, ry, { width: TW.qty, align: "right" });

      doc.text(fmtTableAmount(item.unit_price, currency), TC.unit, ry, {
        width: TW.unit,
        align: "right",
      });

      let rSubY = ry + 12;
      for (const rs of rateSubtexts) {
        doc.font("Helvetica").fontSize(8).fillColor(C_MUTED);
        doc.text(rs, TC.unit, rSubY, { width: TW.unit, align: "right" });
        rSubY += 11;
      }

      doc.font("Helvetica").fontSize(FS_TABLE).fillColor(C_TEXT);
      doc.text(fmtTableAmount(item.amount, currency), TC.total, ry, {
        width: TW.total,
        align: "right",
      });

      tableY += rowH;
      hline(tableY, C_BORDER, 0.5);
    }

    // ── Totals block ──────────────────────────────────────────────────────────
    const totW = 230;
    const totX = MARGIN + CONTENT_W - totW;
    const lblW = 115;
    const valW = totW - lblW;
    let ty = tableY + 16;

    const totRow = (lbl: string, val: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS_TABLE).fillColor(C_TEXT);
      doc.text(lbl, totX, ty, { width: lblW, align: "left" });
      doc.text(val, totX + lblW, ty, { width: valW, align: "right" });
      ty += 16;
    };

    totRow("Subtotal", fmtTotals(data.subtotal, currency));

    const discountAmt = data.discount_amount ?? 0;
    if (discountAmt > 0) {
      totRow("Discount", `-${fmtTotals(discountAmt, currency)}`);
    }

    const pdfTaxes =
      data.taxes?.length
        ? data.taxes
        : data.tax_rate > 0
          ? [
              {
                rate: data.tax_rate,
                name: String(data.tax_rate),
                tax_number: data.company_vat_number,
                amount: data.tax_amount,
              },
            ]
          : [];

    for (const tax of pdfTaxes) {
      if (tax.rate <= 0 && tax.amount <= 0) continue;
      totRow(taxRowLabel(tax), fmtTotals(tax.amount, currency));
      const taxNum = tax.tax_number?.trim();
      if (taxNum) {
        doc.font("Helvetica").fontSize(8).fillColor(C_MUTED);
        doc.text(taxNum, totX, ty - 4, { width: lblW, align: "left" });
        ty += 10;
      }
    }

    if (pdfTaxes.length === 0 && data.tax_amount > 0) {
      totRow("Tax", fmtTotals(data.tax_amount, currency));
    }

    totRow("Total", fmtTotals(data.total, currency), true);
    totRow("Amount Paid", fmtTotals(amountPaid, currency));

    ty += 2;
    hline(ty);
    ty += 12;

    doc.font("Helvetica-Bold").fontSize(FS_BODY).fillColor(C_LABEL);
    doc.text(`Amount Due (${currency})`, totX, ty, { width: lblW, align: "left" });
    doc.font("Helvetica-Bold").fontSize(FS_BODY).fillColor(C_TEXT);
    doc.text(fmtDue(amountDue, currency), totX + lblW, ty, { width: valW, align: "right" });
    ty += 28;

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (data.notes) {
      if (ty > PAGE_H - 100) {
        doc.addPage();
        ty = MARGIN + 20;
      }
      doc.font("Helvetica-Bold").fontSize(FS_BODY).fillColor(C_TEXT).text("Notes", MARGIN, ty);
      ty += 14;
      for (const line of splitLines(data.notes)) {
        doc.font("Helvetica").fontSize(FS_TABLE).fillColor(C_TEXT);
        doc.text(line, MARGIN, ty, { width: CONTENT_W, lineGap: 2 });
        ty = doc.y + 2;
      }
      ty += 12;
    }

    // ── Terms ─────────────────────────────────────────────────────────────────
    if (data.terms) {
      if (ty > PAGE_H - 80) {
        doc.addPage();
        ty = MARGIN + 20;
      }
      doc.font("Helvetica-Bold").fontSize(FS_BODY).fillColor(C_TEXT).text("Terms", MARGIN, ty);
      ty += 14;
      for (const line of splitLines(data.terms)) {
        doc.font("Helvetica").fontSize(FS_TABLE).fillColor(C_TEXT);
        doc.text(line, MARGIN, ty, { width: CONTENT_W, lineGap: 2 });
        ty = doc.y + 2;
      }
    }

    doc.end();
  });
}
