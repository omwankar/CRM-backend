import { sendGraphMail } from "./graphMailSend.js";

export type SendQuotationEmailInput = {
  to: string;
  quotationNumber: string;
  clientName: string;
  total: number;
  currency: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  message?: string | null;
};

export async function sendQuotationEmail(input: SendQuotationEmailInput): Promise<{ id: string }> {
  const company = process.env.COMPANY_NAME?.trim() || "Your Company";
  const totalStr = `${input.currency} ${input.total.toFixed(2)}`;
  const extra = input.message?.trim()
    ? `<p>${input.message.trim().replace(/\n/g, "<br/>")}</p>`
    : "";

  return sendGraphMail({
    to: input.to,
    subject: `Quotation ${input.quotationNumber} from ${company}`,
    htmlBody: `
      <p>Hello${input.clientName ? ` ${input.clientName}` : ""},</p>
      <p>Please find attached our quotation <strong>${input.quotationNumber}</strong>.</p>
      <p><strong>Quoted amount:</strong> ${totalStr}</p>
      ${extra}
      <p>Thank you for your enquiry.</p>
      <p>— ${company}</p>
    `,
    attachments: [
      {
        filename: input.pdfFilename,
        contentType: "application/pdf",
        content: input.pdfBuffer,
      },
    ],
  });
}
