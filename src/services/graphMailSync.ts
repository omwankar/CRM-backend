import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  collectUserEmails,
  extractEmails,
  getGraphAccessToken,
  getAllowedEmailDomains,
  getSyncAllowlist,
  graphGet,
  hasSyncAllowlist,
  normalizeEmail,
  resolveMailboxEmail,
  shouldSyncUser,
  syncAllTenantUsers,
  type GraphListResponse,
  type GraphMessage,
  type GraphUser,
} from "./graphClient.js";

let db: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!db) {
    db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
  }
  return db;
}

type LinkIds = {
  lead_id?: string | null;
  buyer_id?: string | null;
  contact_id?: string | null;
  project_id?: string | null;
  quotation_id?: string | null;
};

const linkCache = {
  leads: new Map<string, string>(),
  buyers: new Map<string, string>(),
  contacts: new Map<string, string>(),
  projects: new Map<string, string>(),
  quotations: new Map<string, string>(),
};

function clearLinkCache() {
  linkCache.leads.clear();
  linkCache.buyers.clear();
  linkCache.contacts.clear();
  linkCache.projects.clear();
  linkCache.quotations.clear();
}

async function findLeadByEmail(email: string): Promise<string | null> {
  const key = email.toLowerCase();
  if (linkCache.leads.has(key)) return linkCache.leads.get(key)!;
  const { data } = await supabase().from("leads").select("id").ilike("email", key).limit(1).maybeSingle();
  if (data?.id) linkCache.leads.set(key, data.id);
  return data?.id ?? null;
}

async function findBuyerByEmail(email: string): Promise<string | null> {
  const key = email.toLowerCase();
  if (linkCache.buyers.has(key)) return linkCache.buyers.get(key)!;
  const { data } = await supabase()
    .from("buyers")
    .select("id")
    .ilike("contact_email", key)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (data?.id) linkCache.buyers.set(key, data.id);
  return data?.id ?? null;
}

async function findContactByEmail(email: string): Promise<string | null> {
  const key = email.toLowerCase();
  if (linkCache.contacts.has(key)) return linkCache.contacts.get(key)!;
  const { data } = await supabase().from("contacts").select("id").ilike("email", key).limit(1).maybeSingle();
  if (data?.id) linkCache.contacts.set(key, data.id);
  return data?.id ?? null;
}

async function findProjectByLinkedEmail(emails: string[]): Promise<string | null> {
  for (const email of emails) {
    const key = email.toLowerCase();
    if (linkCache.projects.has(key)) return linkCache.projects.get(key)!;
    const { data } = await supabase()
      .from("projects")
      .select("id")
      .ilike("linked_email", key)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      linkCache.projects.set(key, data.id);
      return data.id;
    }
  }
  return null;
}

async function findQuotationInSubject(subject: string): Promise<string | null> {
  const match = subject.match(/\b(QT[-\s]?\d{4}[-\s]?\d+)\b/i);
  if (!match) return null;
  const ref = match[1].replace(/\s+/g, "-").toUpperCase();
  if (linkCache.quotations.has(ref)) return linkCache.quotations.get(ref)!;
  const { data } = await supabase()
    .from("quotations")
    .select("id")
    .ilike("quotation_number", ref)
    .limit(1)
    .maybeSingle();
  if (data?.id) linkCache.quotations.set(ref, data.id);
  return data?.id ?? null;
}

export async function autoLinkEmail(input: {
  sender_email?: string | null;
  to_emails?: string[];
  cc_emails?: string[];
  subject?: string | null;
}): Promise<LinkIds> {
  const links: LinkIds = {};
  const allAddresses = new Set<string>();
  if (input.sender_email) allAddresses.add(input.sender_email.toLowerCase());
  for (const e of [...(input.to_emails || []), ...(input.cc_emails || [])]) {
    allAddresses.add(e.toLowerCase());
  }

  if (input.subject) {
    links.quotation_id = await findQuotationInSubject(input.subject);
  }

  if (input.sender_email) {
    const sender = input.sender_email.toLowerCase();
    links.lead_id = await findLeadByEmail(sender);
    links.buyer_id = await findBuyerByEmail(sender);
    links.contact_id = await findContactByEmail(sender);
  }

  if (!links.project_id) {
    links.project_id = await findProjectByLinkedEmail([...allAddresses]);
  }

  return links;
}

const USER_SELECT =
  "id,displayName,mail,userPrincipalName,otherMails,proxyAddresses,userType";

/** Resolve shared / allowlisted emails not returned from the member scan (e.g. info@clarusto.co.uk). */
async function appendAllowlistMailboxes(
  token: string,
  users: GraphUser[],
): Promise<GraphUser[]> {
  const list = getSyncAllowlist();
  if (!list?.emails.length) return users;

  const byId = new Map(users.map((u) => [u.id, u]));
  const knownEmails = new Set(users.flatMap((u) => collectUserEmails(u)));

  for (const email of list.emails) {
    if (knownEmails.has(email)) continue;

    try {
      const user = await graphGet<GraphUser>(
        `/users/${encodeURIComponent(email)}?$select=${USER_SELECT}`,
        token,
      );
      if (user?.id) {
        byId.set(user.id, user);
        for (const e of collectUserEmails(user)) knownEmails.add(e);
        continue;
      }
    } catch {
      // fall through to filter search
    }

    try {
      const escaped = email.replace(/'/g, "''");
      const page = await graphGet<GraphListResponse<GraphUser>>(
        `/users?$select=${USER_SELECT}&$filter=mail eq '${escaped}' or userPrincipalName eq '${escaped}'&$top=1`,
        token,
      );
      const hit = page.value[0];
      if (hit?.id) {
        byId.set(hit.id, hit);
        for (const e of collectUserEmails(hit)) knownEmails.add(e);
      }
    } catch (err) {
      console.warn(`[email-sync] Could not resolve allowlist mailbox ${email}:`, err);
    }
  }

  return [...byId.values()];
}

async function deactivateMailboxesOutsideAllowlist(activeGraphUserIds: string[]) {
  if (!hasSyncAllowlist()) return;

  const { data: all } = await supabase().from("mailboxes").select("id, graph_user_id, email");
  for (const mb of all || []) {
    const keep = activeGraphUserIds.includes(mb.graph_user_id as string);
    if (!keep && mb.graph_user_id) {
      await supabase().from("mailboxes").update({ is_active: false }).eq("id", mb.id);
    }
  }
}

async function listTenantUsers(token: string): Promise<GraphUser[]> {
  const users: GraphUser[] = [];
  let totalInTenant = 0;
  let path: string | null =
    `/users?$select=${USER_SELECT}&$top=100&$filter=accountEnabled eq true and userType eq 'Member'`;

  while (path) {
    const page: GraphListResponse<GraphUser> = await graphGet<GraphListResponse<GraphUser>>(path, token);
    totalInTenant += page.value.length;
    for (const user of page.value) {
      if (shouldSyncUser(user)) users.push(user);
    }
    path = page["@odata.nextLink"] ?? null;
  }

  const merged = await appendAllowlistMailboxes(token, users);

  const mode = hasSyncAllowlist()
    ? `allowlist (${getSyncAllowlist()!.names.length + getSyncAllowlist()!.emails.length} entries)`
    : syncAllTenantUsers()
      ? "all enabled members"
      : `domains: ${getAllowedEmailDomains().map((d) => `@${d}`).join(", ")}`;
  console.log(
    `[email-sync] Azure AD members: ${totalInTenant}, mailboxes to sync: ${merged.length} (${mode})`,
  );

  return merged;
}

/** Debug: list every member and whether they would be synced (super_admin diagnostics). */
export async function discoverTenantMailboxes(): Promise<
  Array<{
    displayName: string;
    mailboxEmail: string | null;
    allEmails: string[];
    included: boolean;
    reason: string;
  }>
> {
  const token = await getGraphAccessToken();
  const rows: Array<{
    displayName: string;
    mailboxEmail: string | null;
    allEmails: string[];
    included: boolean;
    reason: string;
  }> = [];

  let path: string | null =
    `/users?$select=${USER_SELECT}&$top=100&$filter=accountEnabled eq true and userType eq 'Member'`;

  while (path) {
    const page: GraphListResponse<GraphUser> = await graphGet<GraphListResponse<GraphUser>>(path, token);
    for (const user of page.value) {
      const allEmails = collectUserEmails(user);
      const mailboxEmail = resolveMailboxEmail(user);
      let reason = "included";
      let included = shouldSyncUser(user);
      if (user.userType === "Guest") {
        included = false;
        reason = "guest account";
      } else if (!allEmails.length) {
        included = false;
        reason = "no email on Azure AD profile";
      } else if (!included) {
        reason = hasSyncAllowlist()
          ? "not on MS_GRAPH_SYNC_ALLOWLIST"
          : `no address matches allowed domains (${getAllowedEmailDomains().join(", ")})`;
      }
      rows.push({
        displayName: user.displayName || mailboxEmail || user.id,
        mailboxEmail,
        allEmails,
        included,
        reason,
      });
    }
    path = page["@odata.nextLink"] ?? null;
  }

  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}

async function upsertMailbox(user: GraphUser): Promise<string> {
  const email = resolveMailboxEmail(user)!;
  const { data, error } = await supabase()
    .from("mailboxes")
    .upsert(
      {
        graph_user_id: user.id,
        email,
        display_name: user.displayName || email,
        is_active: true,
      },
      { onConflict: "graph_user_id" },
    )
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return data.id as string;
}

function mapMessage(
  msg: GraphMessage,
  mailboxId: string,
  mailboxEmail: string,
  links: LinkIds,
) {
  const senderEmail = normalizeEmail(msg.from?.emailAddress?.address);
  const toEmails = extractEmails(msg.toRecipients);
  const ccEmails = extractEmails(msg.ccRecipients);
  const receivedAt = msg.receivedDateTime || msg.sentDateTime || new Date().toISOString();
  const direction =
    senderEmail && senderEmail === mailboxEmail.toLowerCase() ? "outbound" : "inbound";

  return {
    graph_message_id: msg.id,
    internet_message_id: msg.internetMessageId || null,
    conversation_id: msg.conversationId || null,
    mailbox_id: mailboxId,
    mailbox_email: mailboxEmail,
    subject: msg.subject || "(No subject)",
    sender_name: msg.from?.emailAddress?.name || null,
    sender_email: senderEmail,
    to_emails: toEmails,
    cc_emails: ccEmails,
    body_preview: msg.bodyPreview || null,
    received_at: receivedAt,
    is_read: Boolean(msg.isRead),
    has_attachments: Boolean(msg.hasAttachments),
    direction,
    ...links,
  };
}

async function fetchMessagesSince(
  token: string,
  graphUserId: string,
  sinceIso: string,
): Promise<GraphMessage[]> {
  const messages: GraphMessage[] = [];
  const select =
    "id,subject,from,toRecipients,ccRecipients,bodyPreview,receivedDateTime,sentDateTime,isRead,hasAttachments,conversationId,internetMessageId";
  const filter = encodeURIComponent(`receivedDateTime ge ${sinceIso}`);
  let path: string | null =
    `/users/${graphUserId}/messages?$top=50&$orderby=receivedDateTime asc&$select=${select}&$filter=${filter}`;

  while (path) {
    const page: GraphListResponse<GraphMessage> = await graphGet<GraphListResponse<GraphMessage>>(path, token);
    messages.push(...page.value);
    path = page["@odata.nextLink"] ?? null;
    if (messages.length >= 500) break;
  }

  return messages;
}

async function syncMailbox(
  token: string,
  mailboxId: string,
  graphUserId: string,
  mailboxEmail: string,
  sinceIso: string,
): Promise<number> {
  const messages = await fetchMessagesSince(token, graphUserId, sinceIso);
  let upserted = 0;

  for (const msg of messages) {
    const senderEmail = normalizeEmail(msg.from?.emailAddress?.address);
    const toEmails = extractEmails(msg.toRecipients);
    const ccEmails = extractEmails(msg.ccRecipients);
    const links = await autoLinkEmail({
      sender_email: senderEmail,
      to_emails: toEmails,
      cc_emails: ccEmails,
      subject: msg.subject,
    });

    const row = mapMessage(msg, mailboxId, mailboxEmail, links);
    const { error } = await supabase()
      .from("company_emails")
      .upsert(row, { onConflict: "mailbox_id,graph_message_id", ignoreDuplicates: false });

    if (!error) upserted += 1;
  }

  await supabase()
    .from("mailboxes")
    .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
    .eq("id", mailboxId);

  return upserted;
}

export interface SyncResult {
  mailboxes_synced: number;
  messages_upserted: number;
  mailboxes_discovered: number;
  run_id: string;
}

export async function runEmailSync(): Promise<SyncResult> {
  clearLinkCache();
  const token = await getGraphAccessToken();
  const syncDays = Math.max(1, Number(process.env.MS_GRAPH_SYNC_DAYS || 30));

  const { data: run, error: runError } = await supabase()
    .from("email_sync_runs")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (runError || !run) throw new Error(runError?.message || "Failed to start sync run");

  const runId = run.id as string;
  let mailboxesSynced = 0;
  let messagesUpserted = 0;

  try {
    const users = await listTenantUsers(token);
    const mailboxesDiscovered = users.length;
    const activeGraphIds: string[] = [];

    for (const user of users) {
      const email = resolveMailboxEmail(user);
      if (!email) continue;

      try {
        const mailboxId = await upsertMailbox(user);
        const { data: mailbox } = await supabase()
          .from("mailboxes")
          .select("last_synced_at")
          .eq("id", mailboxId)
          .maybeSingle();

        const since = mailbox?.last_synced_at
          ? new Date(new Date(mailbox.last_synced_at).getTime() - 5 * 60_000).toISOString()
          : new Date(Date.now() - syncDays * 24 * 60 * 60 * 1000).toISOString();

        const count = await syncMailbox(token, mailboxId, user.id, email, since);
        activeGraphIds.push(user.id);
        mailboxesSynced += 1;
        messagesUpserted += count;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sync failed";
        await supabase()
          .from("mailboxes")
          .update({ last_sync_error: message })
          .eq("graph_user_id", user.id);
        console.error(`[email-sync] ${email}:`, message);
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    await deactivateMailboxesOutsideAllowlist(activeGraphIds);

    await supabase()
      .from("email_sync_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        mailboxes_synced: mailboxesSynced,
        messages_upserted: messagesUpserted,
      })
      .eq("id", runId);

    return {
      mailboxes_synced: mailboxesSynced,
      messages_upserted: messagesUpserted,
      mailboxes_discovered: mailboxesDiscovered,
      run_id: runId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await supabase()
      .from("email_sync_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        mailboxes_synced: mailboxesSynced,
        messages_upserted: messagesUpserted,
        error_message: message,
      })
      .eq("id", runId);
    throw err;
  }
}

export async function fetchMessageBody(
  graphUserId: string,
  graphMessageId: string,
): Promise<{ body_html: string | null; body_text: string | null }> {
  const token = await getGraphAccessToken();
  const msg = await graphGet<GraphMessage>(
    `/users/${graphUserId}/messages/${graphMessageId}?$select=body`,
    token,
  );
  const content = msg.body?.content || null;
  if (msg.body?.contentType?.toLowerCase() === "html") {
    return { body_html: content, body_text: null };
  }
  return { body_html: null, body_text: content };
}
