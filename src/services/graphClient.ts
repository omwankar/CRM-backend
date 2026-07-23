const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let cachedToken: { value: string; expiresAt: number } | null = null;

export function isGraphConfigured(): boolean {
  return Boolean(
    process.env.MS_GRAPH_TENANT_ID &&
      process.env.MS_GRAPH_CLIENT_ID &&
      process.env.MS_GRAPH_CLIENT_SECRET,
  );
}

export function getGraphDomain(): string {
  return (process.env.MS_GRAPH_DOMAIN || "clarusto.co.uk").toLowerCase();
}

/** Comma-separated domains from MS_GRAPH_DOMAINS, or MS_GRAPH_DOMAIN + common M365 default. */
export function getAllowedEmailDomains(): string[] {
  const raw = process.env.MS_GRAPH_DOMAINS || process.env.MS_GRAPH_DOMAIN || "clarusto.co.uk";
  const fromList = raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  const domains = new Set(fromList);
  // Default: include tenant onmicrosoft.com if only custom domain was set
  if (!process.env.MS_GRAPH_DOMAINS && process.env.MS_GRAPH_DOMAIN) {
    domains.add("clarustogroup.onmicrosoft.com");
  }
  return [...domains];
}

export function syncAllTenantUsers(): boolean {
  if (hasSyncAllowlist()) return false;
  return process.env.MS_GRAPH_SYNC_ALL_TENANT_USERS === "true";
}

export type SyncAllowlist = { names: string[]; emails: string[] };

/** Comma-separated display names and/or emails — when set, only these mailboxes sync. */
export function getSyncAllowlist(): SyncAllowlist | null {
  const raw = process.env.MS_GRAPH_SYNC_ALLOWLIST?.trim();
  if (!raw) return null;
  const names: string[] = [];
  const emails: string[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("@")) emails.push(p.toLowerCase());
    else names.push(p.toLowerCase());
  }
  if (!names.length && !emails.length) return null;
  return { names, emails };
}

export function hasSyncAllowlist(): boolean {
  return getSyncAllowlist() !== null;
}

function normalizePersonName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function matchesSyncAllowlist(user: GraphUser): boolean {
  const list = getSyncAllowlist();
  if (!list) return true;

  const displayName = normalizePersonName(user.displayName || "");
  const userEmails = collectUserEmails(user);
  const mailboxEmail = normalizeEmail(resolveMailboxEmail(user));
  const allEmails = [...new Set([...userEmails, ...(mailboxEmail ? [mailboxEmail] : [])])];

  for (const allowed of list.emails) {
    if (allEmails.includes(allowed)) return true;
  }

  for (const name of list.names) {
    const n = normalizePersonName(name);
    if (!n) continue;
    if (displayName === n) return true;
    if (displayName.startsWith(`${n} `) || displayName.endsWith(` ${n}`)) return true;
    if (n.length >= 3 && displayName.includes(n)) return true;
    if (n.split(" ").length === 1 && displayName.split(/\s+/).includes(n)) return true;
    // Match allowlist name to email local-part (e.g. "Ansu" ↔ ansu@clarusto.co.uk)
    for (const email of allEmails) {
      const local = email.split("@")[0] || "";
      if (local === n || local.replace(/[._-]/g, "") === n.replace(/\s+/g, "")) return true;
    }
  }

  return false;
}

export function matchesDomain(email: string, domain: string): boolean {
  return email.endsWith(`@${domain.toLowerCase()}`);
}

export function matchesAnyAllowedDomain(email: string): boolean {
  if (syncAllTenantUsers()) return true;
  const lower = email.toLowerCase();
  return getAllowedEmailDomains().some((d) => lower.endsWith(`@${d}`));
}

export async function getGraphAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const tenantId = process.env.MS_GRAPH_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Microsoft Graph credentials are not configured");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    const desc = data.error_description || data.error || "Failed to obtain Graph token";
    if (desc.includes("AADSTS7000215") || desc.includes("Invalid client secret")) {
      throw new Error(
        "Invalid Microsoft Graph client secret. In backend/.env set MS_GRAPH_CLIENT_SECRET to the secret VALUE from Azure (Certificates & secrets → Value column), not the Secret ID. Create a new secret if you no longer have the value.",
      );
    }
    throw new Error(desc);
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return data.access_token;
}

export async function graphGet<T>(path: string, token: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API ${res.status}: ${err.slice(0, 500)}`);
  }

  return res.json() as Promise<T>;
}

export async function graphPost<T = void>(path: string, token: string, body: unknown): Promise<T> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    let message = `Graph API ${res.status}: ${err.slice(0, 500)}`;
    if (res.status === 403 || /ErrorAccessDenied|AccessDenied/i.test(err)) {
      message +=
        " Ensure the Azure app has Application permission Mail.Send (with admin consent) and permission to send as the configured mailbox.";
    }
    throw new Error(message);
  }

  if (res.status === 204 || res.status === 202) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Mailbox used for outbound quotation/invoice emails (Microsoft 365). */
export function getSendFromEmail(): string | null {
  return (
    process.env.MS_GRAPH_SEND_FROM_EMAIL?.trim() ||
    process.env.INVOICE_FROM_EMAIL?.trim() ||
    null
  );
}

export function isGraphSendConfigured(): boolean {
  return isGraphConfigured() && Boolean(getSendFromEmail());
}

export interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  otherMails?: string[];
  proxyAddresses?: string[];
  userType?: string;
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: GraphEmailAddress };
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  conversationId?: string;
  internetMessageId?: string;
}

export interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export function normalizeEmail(addr?: string | null): string | null {
  if (!addr) return null;
  return addr.trim().toLowerCase();
}

export function extractEmails(recipients?: GraphRecipient[]): string[] {
  if (!recipients?.length) return [];
  return recipients
    .map((r) => normalizeEmail(r.emailAddress?.address))
    .filter((e): e is string => Boolean(e));
}

/** All known email addresses for an Azure AD user (mail, UPN, aliases, Exchange proxyAddresses). */
export function collectUserEmails(user: GraphUser): string[] {
  const emails = new Set<string>();
  for (const raw of [user.mail, user.userPrincipalName, ...(user.otherMails || [])]) {
    const n = normalizeEmail(raw);
    if (n) emails.add(n);
  }
  for (const proxy of user.proxyAddresses || []) {
    const upper = proxy.toUpperCase();
    if (upper.startsWith("SMTP:") || upper.startsWith("SIP:")) {
      const addr = normalizeEmail(proxy.slice(proxy.indexOf(":") + 1));
      if (addr) emails.add(addr);
    }
  }
  return [...emails];
}

/** Best mailbox address for CRM display — prefers @clarusto.co.uk over onmicrosoft.com UPN. */
export function resolveMailboxEmail(user: GraphUser): string | null {
  const all = collectUserEmails(user);
  if (!all.length) return null;

  const domains = getAllowedEmailDomains();
  // Prefer custom domain (not onmicrosoft.com) for display
  for (const d of domains) {
    if (d.includes("onmicrosoft.com")) continue;
    const hit = all.find((e) => e.endsWith(`@${d}`));
    if (hit) return hit;
  }
  for (const d of domains) {
    const hit = all.find((e) => e.endsWith(`@${d}`));
    if (hit) return hit;
  }
  return all[0];
}

export function userMailboxEmail(user: GraphUser): string | null {
  return resolveMailboxEmail(user);
}

export function shouldSyncUser(user: GraphUser): boolean {
  if (user.userType === "Guest") return false;

  if (hasSyncAllowlist()) {
    return matchesSyncAllowlist(user);
  }

  const emails = collectUserEmails(user);
  if (!emails.length) return false;
  if (syncAllTenantUsers()) return true;
  return emails.some((e) => matchesAnyAllowedDomain(e));
}
