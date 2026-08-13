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

/** Prefer mobile, then labeled phone, then any international number */
function extractPhone(text: string): string | null {
  const clean = (n: string) => n.replace(/\s+/g, " ").trim();
  const isValid = (n: string) => {
    const digits = n.replace(/\D/g, "");
    // E.164 allows up to 15 digits; reject junk like "1801)) ("
    return digits.length >= 8 && digits.length <= 15;
  };

  // "+44 (0) 741 845 5773 (mobile)" / "+91 98xxx (mobile)" — prefer mobile
  const mobileLabeled = text.match(
    /(\+?\d[\d\s().\-\/]{6,}\d)\s*\(\s*mobile\s*\)/i,
  );
  if (mobileLabeled && isValid(mobileLabeled[1])) return clean(mobileLabeled[1]);

  const phoneLabeled = text.match(
    /(\+?\d[\d\s().\-\/]{6,}\d)\s*\(\s*phone\s*\)/i,
  );
  if (phoneLabeled && isValid(phoneLabeled[1])) return clean(phoneLabeled[1]);

  // "Mobile: +91..." / "Tel: +1..." / "WhatsApp: +971..."
  const labeled = text.match(
    /(?:whatsapp|mobile|mob|cell|tel|telephone|phone|ph\.?|m\.?|t\.?)[\s.:]*(\+?\d[\d\s\-().\/]{6,}\d)/i,
  );
  if (labeled && isValid(labeled[1])) return clean(labeled[1]);

  // tel: link leftover (any country)
  const telLink = text.match(/tel:([+\d][\d\-().\s\/]{6,}\d)/i);
  if (telLink && isValid(telLink[1])) return clean(telLink[1]);

  // Any international number starting with + (most reliable across countries)
  const intl = text.match(/(?<!\w)(\+\d{1,4}[\s\-().\/]*\d[\d\s\-().\/]{5,}\d)/);
  if (intl && isValid(intl[1])) return clean(intl[1]);

  // Local numbers without + (8–15 digits)
  const bare = text.match(/(?<!\w)(\(?0?\d[\d\s\-().\/]{6,}\d)(?!\w)/);
  if (bare && isValid(bare[1])) return clean(bare[1]);

  return null;
}

/** Extract company name from a signature block like Clarusto-style HTML signatures */
function extractCompany(text: string): string | null {
  // Explicit label — but NOT "Company number" / VAT / EORI registration lines
  const labeled = text.match(
    /(?:^|\n)\s*(?:company|organisation|organization|firm)\s*[:\-]\s*([^\n|,]{3,80})/im,
  );
  if (labeled) {
    const v = labeled[1].trim();
    if (
      v.length >= 3 &&
      !/^(number|no\.?|reg|registration|vat|eori)\b/i.test(v) &&
      !/^SC\d+/i.test(v) &&
      !/^GB\d+/i.test(v)
    ) {
      return v;
    }
  }

  // Website → company guess: www.clorustologistics.com → Clorustologistics
  let webCompany: string | null = null;
  const web = text.match(
    /(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9\-]+)\.(?:com|co\.uk|uk|net|io|org)\b/i,
  );
  if (web) {
    const host = web[1];
    // skip free mail / social / common non-company hosts
    if (
      !/^(gmail|google|yahoo|hotmail|outlook|live|linkedin|twitter|facebook|instagram|youtube|bit|tinyurl)$/i.test(
        host,
      )
    ) {
      webCompany = host.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // Lines that look like company names (Logistics, Shipping, Ltd, etc.)
  const lines = text
    .split(/\n|\|/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 3 && l.length < 80);

  const companyWord =
    /\b(ltd|llc|inc|corp|group|solutions|shipping|logistics|international|trading|global|industries|services|consultancy|associates|partners|plc|gmbh|bv|pvt|freight|haulage|transport)\b/i;

  for (const line of lines) {
    // skip phone / email / address / registration / social lines
    if (
      /@|^\+?\d|www\.|https?:|linkedin|instagram|facebook|twitter|company\s*number|eori|vat\s*number|registration|^\(?\d{1,4}\)?\s*[),]/i.test(
        line,
      )
    ) {
      continue;
    }
    if (companyWord.test(line)) return line;
  }

  // Title line often sits above company:
  // "Business Operations\nClorusto Logistics"
  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1];
    if (
      /^(business|operations|director|manager|sales|ceo|cfo|coo|founder|partner|consultant|executive)/i.test(
        lines[i],
      ) &&
      next &&
      !/@|^\+?\d|www\.|company\s*number|vat|eori/i.test(next) &&
      next.split(/\s+/).length <= 6
    ) {
      return next;
    }
  }

  return webCompany;
}

/** Strip HTML tags and decode basic entities — keep tel:/mailto: values */
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Preserve phone/email from links before stripping tags
    .replace(/<a[^>]+href=["']tel:([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<a[^>]+href=["']mailto:([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract the signature block after Regards / -- etc. */
function extractSignatureBlock(bodyText: string): string {
  const delimiters = [
    /^--\s*$/m,
    /^_{2,}$/m,
    /^-{2,}$/m,
    /best regards?[,:]?/im,
    /kind regards?[,:]?/im,
    /warm regards?[,:]?/im,
    /regards?[,:]?/im,
    /thanks?[,:]?/im,
    /sincerely[,:]?/im,
    /cheers[,:]?/im,
  ];

  for (const delimiter of delimiters) {
    const idx = bodyText.search(delimiter);
    if (idx !== -1) {
      // HTML signatures can be long (logo + address + VAT etc.)
      return bodyText.slice(idx).slice(0, 2500);
    }
  }

  const lines = bodyText.split("\n");
  return lines.slice(Math.max(0, lines.length - 35)).join("\n").slice(0, 2500);
}

function parseSignatureFromContent(input: {
  body_html?: string | null;
  body_text?: string | null;
  body_preview?: string | null;
}): { sig_phone: string | null; sig_company: string | null } {
  const bodyText = input.body_html
    ? htmlToText(input.body_html)
    : input.body_text || input.body_preview || "";

  if (!bodyText) return { sig_phone: null, sig_company: null };

  const sigBlock = extractSignatureBlock(bodyText);
  // Also scan full text for phone — signatures sometimes sit above the delimiter match
  const phone = extractPhone(sigBlock) || extractPhone(bodyText);
  const company = extractCompany(sigBlock) || extractCompany(bodyText);
  return { sig_phone: phone, sig_company: company };
}

function parseSignature(msg: GraphMessage): { sig_phone: string | null; sig_company: string | null } {
  const bodyContent = msg.body?.content || "";
  const isHtml = msg.body?.contentType?.toLowerCase() === "html";
  return parseSignatureFromContent({
    body_html: isHtml ? bodyContent : null,
    body_text: isHtml ? null : bodyContent,
    body_preview: msg.bodyPreview || null,
  });
}

/** Guess company from sender display name or email domain when signature has none */
export function guessCompanyFromSender(senderName: string | null, senderEmail: string | null): string | null {
  const name = (senderName || "").trim();
  if (
    name &&
    /\b(ltd|llc|inc|corp|group|solutions|shipping|international|trading|global|industries|services|consultancy|associates|partners|plc|gmbh|bv|pvt|co\.|company)\b/i.test(
      name,
    )
  ) {
    return name;
  }

  const email = (senderEmail || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  if (!domain) return null;
  // Skip free / generic mail providers
  if (
    /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol|mail|protonmail|qq|163|126|vip\.126|me)\./i.test(
      domain,
    ) ||
    /^(gmail|yahoo|hotmail|outlook|live|icloud|aol|protonmail|qq|163|126)\.com$/i.test(domain)
  ) {
    return null;
  }
  // e.g. sales@aasaj-shipping.com → aasaj-shipping
  const base = domain.split(".")[0];
  if (!base || base.length < 2) return null;
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isJunkPhone(value: string | null | undefined): boolean {
  if (!value) return true;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return true; // dates mistaken as phones
  if (/\)\s*\(/.test(value) || /\)\)/.test(value)) return true;
  return false;
}

function isJunkCompany(value: string | null | undefined): boolean {
  if (!value) return true;
  if (value.length > 60) return true;
  if (/^(number|no\.?)\s*:/i.test(value)) return true;
  if (/^SC\d+/i.test(value)) return true;
  if (/company\s*number|vat\s*number|eori|shall cease/i.test(value)) return true;
  return false;
}

export type BackfillResult = {
  processed: number;
  updated: number;
  phones: number;
  companies: number;
  errors: number;
  mode: "batch" | "all";
  background?: boolean;
};

/**
 * Re-parse phone/company from email bodies.
 * - force: overwrite junk / recompute even if fields already set
 * - all: page through every inbound email (stored bodies first, then Graph fetch for missing)
 * - fetchMissingBodies: call Microsoft Graph when body_html/body_text are empty
 */
export async function backfillEmailSignatures(options: {
  limit?: number;
  force?: boolean;
  all?: boolean;
  fetchMissingBodies?: boolean;
} = {}): Promise<BackfillResult> {
  const all = Boolean(options.all);
  const force = Boolean(options.force ?? all);
  const fetchMissingBodies = options.fetchMissingBodies !== false;
  const pageSize = all ? 500 : Math.min(Math.max(1, options.limit || 200), 1000);

  let processed = 0;
  let updated = 0;
  let phones = 0;
  let companies = 0;
  let errors = 0;
  let from = 0;

  // Cache mailbox → graph user
  const graphByMailbox = new Map<string, string>();
  async function resolveGraphUser(mailboxId: string): Promise<string | null> {
    if (graphByMailbox.has(mailboxId)) return graphByMailbox.get(mailboxId)!;
    const { data } = await supabase()
      .from("mailboxes")
      .select("graph_user_id")
      .eq("id", mailboxId)
      .maybeSingle();
    const gid = (data?.graph_user_id as string) || null;
    if (gid) graphByMailbox.set(mailboxId, gid);
    return gid;
  }

  while (true) {
    let query = supabase()
      .from("company_emails")
      .select(
        "id, graph_message_id, mailbox_id, sender_name, sender_email, body_html, body_text, body_preview, sig_phone, sig_company",
      )
      .eq("direction", "inbound")
      .not("sender_email", "is", null)
      .order("received_at", { ascending: false })
      .range(from, from + pageSize - 1);

    if (!force && !all) {
      query = query.or(
        "sig_phone.is.null,sig_company.is.null,body_html.is.null,body_text.is.null",
      );
    }

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    if (!rows?.length) break;

    for (const row of rows) {
      processed += 1;
      try {
        let bodyHtml = row.body_html as string | null;
        let bodyText = row.body_text as string | null;

        // Fetch full body from Graph when missing
        if (
          fetchMissingBodies &&
          !bodyHtml &&
          !bodyText &&
          row.graph_message_id &&
          row.mailbox_id
        ) {
          const graphUserId = await resolveGraphUser(row.mailbox_id as string);
          if (graphUserId) {
            try {
              const fetched = await fetchMessageBody(graphUserId, row.graph_message_id as string);
              bodyHtml = fetched.body_html;
              bodyText = fetched.body_text;
              await new Promise((r) => setTimeout(r, 50));
            } catch (err) {
              errors += 1;
              console.warn(
                "[email-backfill] graph fetch failed",
                row.id,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }

        const parsed = parseSignatureFromContent({
          body_html: bodyHtml,
          body_text: bodyText,
          body_preview: row.body_preview as string | null,
        });

        const existingPhone = row.sig_phone as string | null;
        const existingCompany = row.sig_company as string | null;

        let sig_phone =
          parsed.sig_phone ||
          (!isJunkPhone(existingPhone) ? existingPhone : null) ||
          null;
        let sig_company =
          parsed.sig_company ||
          (!isJunkCompany(existingCompany) ? existingCompany : null) ||
          guessCompanyFromSender(row.sender_name as string | null, row.sender_email as string | null);

        if (force) {
          // Prefer freshly parsed values; clear junk even if nothing better found
          sig_phone = parsed.sig_phone || (!isJunkPhone(existingPhone) ? existingPhone : null);
          sig_company =
            parsed.sig_company ||
            guessCompanyFromSender(row.sender_name as string | null, row.sender_email as string | null) ||
            (!isJunkCompany(existingCompany) ? existingCompany : null);
        }

        const patch: Record<string, unknown> = {};
        // Never keep full bodies in DB after parse
        if (row.body_html) patch.body_html = null;
        if (row.body_text) patch.body_text = null;

        if (force) {
          if (sig_phone !== existingPhone) patch.sig_phone = sig_phone;
          if (sig_company !== existingCompany) patch.sig_company = sig_company;
          // Always clear junk even if result is null
          if (isJunkPhone(existingPhone) && !sig_phone) patch.sig_phone = null;
          if (isJunkCompany(existingCompany) && !sig_company) patch.sig_company = null;
        } else {
          if (sig_phone && (!existingPhone || isJunkPhone(existingPhone))) patch.sig_phone = sig_phone;
          if (sig_company && (!existingCompany || isJunkCompany(existingCompany))) {
            patch.sig_company = sig_company;
          }
        }

        if (Object.keys(patch).length) {
          const { error: upErr } = await supabase()
            .from("company_emails")
            .update(patch)
            .eq("id", row.id);
          if (upErr) {
            errors += 1;
          } else {
            updated += 1;
            if (patch.sig_phone) phones += 1;
            if (patch.sig_company) companies += 1;
          }
        }
      } catch (err) {
        errors += 1;
        console.warn("[email-backfill]", row.id, err instanceof Error ? err.message : err);
      }
    }

    // For limited batch mode, stop after one page
    if (!all) break;

    from += pageSize;
    // Safety: if page returned fewer than pageSize, we're done
    if (rows.length < pageSize) break;

    console.log(
      `[email-backfill] progress processed=${processed} updated=${updated} phones=${phones} companies=${companies}`,
    );
  }

  return {
    processed,
    updated,
    phones,
    companies,
    errors,
    mode: all ? "all" : "batch",
  };
}

let fullBackfillRunning = false;

/** Start a full DB re-parse in the background (does not block HTTP). */
export function startFullSignatureBackfill(): { started: boolean; message: string } {
  if (fullBackfillRunning) {
    return { started: false, message: "Full signature backfill already running" };
  }
  fullBackfillRunning = true;
  setImmediate(() => {
    backfillEmailSignatures({ all: true, force: true, fetchMissingBodies: true })
      .then((r) => {
        console.log("[email-backfill] FULL DONE", r);
      })
      .catch((err) => {
        console.error("[email-backfill] FULL FAILED", err);
      })
      .finally(() => {
        fullBackfillRunning = false;
      });
  });
  return {
    started: true,
    message: "Full signature re-parse started in background for all inbound emails",
  };
}

export function isFullSignatureBackfillRunning(): boolean {
  return fullBackfillRunning;
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

  const parsed = parseSignature(msg);
  const senderName = msg.from?.emailAddress?.name || null;
  const sig_phone = parsed.sig_phone;
  const sig_company = parsed.sig_company || guessCompanyFromSender(senderName, senderEmail);

  return {
    graph_message_id: msg.id,
    internet_message_id: msg.internetMessageId || null,
    conversation_id: msg.conversationId || null,
    mailbox_id: mailboxId,
    mailbox_email: mailboxEmail,
    subject: msg.subject || "(No subject)",
    sender_name: senderName,
    sender_email: senderEmail,
    to_emails: toEmails,
    cc_emails: ccEmails,
    body_preview: msg.bodyPreview || null,
    // Do not persist full HTML — it bloats the DB. Body is fetched from Graph on open.
    body_html: null,
    body_text: null,
    sig_phone,
    sig_company,
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
    "id,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,sentDateTime,isRead,hasAttachments,conversationId,internetMessageId";
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
