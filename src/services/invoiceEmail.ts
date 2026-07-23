import { sendGraphMail } from "./graphMailSend.js";

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
  const company = process.env.COMPANY_NAME?.trim() || "Your Company";
  const totalStr = `${input.currency} ${input.total.toFixed(2)}`;

  return sendGraphMail({
    to: input.to,
    subject: `Invoice ${input.invoiceNumber} from ${company}`,
    htmlBody: `
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
        contentType: "application/pdf",
        content: input.pdfBuffer,
      },
    ],
  });
}
