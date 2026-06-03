import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { resolveInvoiceLogoPath } from "./invoicePdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type QuotationPdfClient = {
  name: string;
  contact_person?: string | null;
  contact_email?: string | null;
  address?: string | null;
};

export type QuotationPdfData = {
  quotation_number: string;
  issue_date: string;
  valid_until?: string | null;
  currency: string;
  amount: number;
  requirement: string;
  notes?: string | null;
  project_name?: string | null;
  client: QuotationPdfClient;
  company_name: string;
  company_address: string;
  company_phone?: string | null;
  company_vat_number?: string | null;
  logo_path?: string | null;
};

const MARGIN = 54;
const PAGE_W = 595.28;
const C_TEXT = "#333333";
const C_MUTED = "#999999";
const C_ACCENT = "#0d9488";

function formatMoney(currency: string, amount: number) {
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === "SAR") return `${n}\u0631.\u0633`;
  return n;
}

export function buildQuotationPdfBuffer(data: QuotationPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const logo = data.logo_path ?? resolveInvoiceLogoPath();
    let y = MARGIN;

    if (logo && fs.existsSync(logo)) {
      doc.image(logo, MARGIN, y, { width: 120 });
    }

    doc.fontSize(10).fillColor(C_TEXT);
    const companyX = PAGE_W - MARGIN - 200;
    doc.text(data.company_name, companyX, y, { width: 200, align: "right" });
    y += 14;
    if (data.company_phone) {
      doc.fillColor(C_MUTED).text(data.company_phone, companyX, y, { width: 200, align: "right" });
      y += 12;
    }
    if (data.company_address) {
      doc.text(data.company_address, companyX, y, { width: 200, align: "right" });
      y += 12;
    }
    if (data.company_vat_number) {
      doc.text(`VAT: ${data.company_vat_number}`, companyX, y, { width: 200, align: "right" });
    }

    y = Math.max(y + 30, 130);
    doc.fontSize(22).fillColor(C_ACCENT).text("QUOTATION", MARGIN, y);
    y += 36;

    const colW = (PAGE_W - MARGIN * 2) / 4;
    const labels = ["Prepared for", "Date", "Quote #", "Amount"];
    const values = [
      data.client.name,
      data.issue_date,
      data.quotation_number,
      formatMoney(data.currency, data.amount),
    ];
    labels.forEach((lbl, i) => {
      const x = MARGIN + colW * i;
      doc.fontSize(8).fillColor(C_ACCENT).text(lbl.toUpperCase(), x, y, { width: colW - 8 });
      doc.fontSize(10).fillColor(C_TEXT).text(values[i] || "—", x, y + 12, { width: colW - 8 });
    });
    y += 44;

    if (data.valid_until) {
      doc.fontSize(9).fillColor(C_MUTED).text(`Valid until: ${data.valid_until}`, MARGIN, y);
      y += 16;
    }
    if (data.project_name) {
      doc.fontSize(9).fillColor(C_MUTED).text(`Project: ${data.project_name}`, MARGIN, y);
      y += 16;
    }

    y += 8;
    doc.fontSize(9).fillColor(C_ACCENT).text("DESCRIPTION", MARGIN, y);
    y += 14;
    doc.fontSize(10).fillColor(C_TEXT).text(data.requirement, MARGIN, y, {
      width: PAGE_W - MARGIN * 2,
      lineGap: 2,
    });
    y = doc.y + 16;

    if (data.notes?.trim()) {
      doc.fontSize(9).fillColor(C_ACCENT).text("NOTES", MARGIN, y);
      y += 14;
      doc.fontSize(9).fillColor(C_TEXT).text(data.notes.trim(), MARGIN, y, {
        width: PAGE_W - MARGIN * 2,
      });
    }

    doc.end();
  });
}
