import {
  getGraphAccessToken,
  getSendFromEmail,
  graphPost,
  isGraphConfigured,
} from "./graphClient.js";

export type GraphMailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

export type SendGraphMailInput = {
  to: string;
  subject: string;
  htmlBody: string;
  attachments?: GraphMailAttachment[];
};

export async function sendGraphMail(input: SendGraphMailInput): Promise<{ id: string }> {
  if (!isGraphConfigured()) {
    throw new Error(
      "Microsoft Graph is not configured. Add MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, and MS_GRAPH_CLIENT_SECRET to backend .env.",
    );
  }

  const from = getSendFromEmail();
  if (!from) {
    throw new Error(
      "Outbound email sender is not configured. Set MS_GRAPH_SEND_FROM_EMAIL (or INVOICE_FROM_EMAIL) to a licensed Microsoft 365 mailbox in backend .env.",
    );
  }

  const token = await getGraphAccessToken();

  const message: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: "HTML", content: input.htmlBody },
    toRecipients: [{ emailAddress: { address: input.to } }],
  };

  if (input.attachments?.length) {
    message.attachments = input.attachments.map((attachment) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: attachment.filename,
      contentType: attachment.contentType,
      contentBytes: attachment.content.toString("base64"),
    }));
  }

  await graphPost(`/users/${encodeURIComponent(from)}/sendMail`, token, {
    message,
    saveToSentItems: true,
  });

  return { id: `graph-${from}-${Date.now()}` };
}
