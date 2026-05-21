import { Resend } from "resend";

export type SendInvoiceEmailInput = {
  to: string;
  invoiceNumber: string;
  buyerName: string;
  total: number;
  currency: string;
  dueDate: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
};

export async function sendInvoiceEmail(input: SendInvoiceEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.INVOICE_FROM_EMAIL?.trim() || process.env.RESEND_FROM_EMAIL?.trim();

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured. Add it to backend .env to send invoices.");
  }
  if (!from) {
    throw new Error("INVOICE_FROM_EMAIL is not configured. Add a verified sender address in backend .env.");
  }

  const resend = new Resend(apiKey);
  const company = process.env.COMPANY_NAME?.trim() || "Your Company";
  const totalStr = `${input.currency} ${input.total.toFixed(2)}`;

  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    subject: `Invoice ${input.invoiceNumber} from ${company}`,
    html: `
      <p>Hello${input.buyerName ? ` ${input.buyerName}` : ""},</p>
      <p>Please find attached invoice <strong>${input.invoiceNumber}</strong>.</p>
      <p><strong>Amount due:</strong> ${totalStr}<br/>
      <strong>Due date:</strong> ${input.dueDate}</p>
      <p>Thank you for your business.</p>
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
    throw new Error(error.message || "Failed to send invoice email");
  }

  return { id: data?.id || "sent" };
}
