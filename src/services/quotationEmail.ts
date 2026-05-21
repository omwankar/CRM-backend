import { Resend } from "resend";

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
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.INVOICE_FROM_EMAIL?.trim() || process.env.RESEND_FROM_EMAIL?.trim();

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured. Add it to backend .env to send quotations.");
  }
  if (!from) {
    throw new Error("INVOICE_FROM_EMAIL is not configured. Add a verified sender address in backend .env.");
  }

  const resend = new Resend(apiKey);
  const company = process.env.COMPANY_NAME?.trim() || "Your Company";
  const totalStr = `${input.currency} ${input.total.toFixed(2)}`;
  const extra = input.message?.trim()
    ? `<p>${input.message.trim().replace(/\n/g, "<br/>")}</p>`
    : "";

  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    subject: `Quotation ${input.quotationNumber} from ${company}`,
    html: `
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
        content: input.pdfBuffer,
      },
    ],
  });

  if (error) {
    throw new Error(error.message || "Failed to send quotation email");
  }

  return { id: data?.id || "sent" };
}
