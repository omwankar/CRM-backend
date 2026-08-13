import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { requireRole, requireSuperAdmin } from "../middleware/requireRole.js";
import { isGraphConfigured, getSyncAllowlist } from "../services/graphClient.js";
import { discoverTenantMailboxes, fetchMessageBody, runEmailSync, backfillEmailSignatures, startFullSignatureBackfill, isFullSignatureBackfillRunning, guessCompanyFromSender } from "../services/graphMailSync.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

let syncInProgress = false;

function isSuperAdmin(req: express.Request): boolean {
  return req.user?.role === "super_admin";
}

function callerMailboxEmail(req: express.Request): string {
  return (req.user?.email || "").trim().toLowerCase();
}

/** Non–super-admins may only see mail for their own CRM login email. */
function canAccessMailbox(req: express.Request, mailboxEmail: string): boolean {
  if (isSuperAdmin(req)) return true;
  const own = callerMailboxEmail(req);
  return Boolean(own) && mailboxEmail.trim().toLowerCase() === own;
}

router.use(authMiddleware);

// GET /api/emails/stats
router.get("/stats", async (req, res) => {
  const graphConfigured = isGraphConfigured();
  const scopedMailbox = isSuperAdmin(req) ? null : callerMailboxEmail(req);
  if (!isSuperAdmin(req) && !scopedMailbox) {
    return res.status(403).json({ error: "No mailbox email on your profile" });
  }

  let total = 0;
  let unlinked = 0;
  let mailboxCount = 0;
  let lastRun = null;
  let db_error: string | null = null;

  let totalQuery = supabase.from("company_emails").select("id", { count: "exact", head: true });
  let unlinkedQuery = supabase
    .from("company_emails")
    .select("id", { count: "exact", head: true })
    .is("lead_id", null)
    .is("buyer_id", null)
    .is("contact_id", null)
    .is("project_id", null)
    .is("quotation_id", null)
    .is("email_category", null);
  let mailboxQuery = supabase.from("mailboxes").select("id", { count: "exact", head: true }).eq("is_active", true);

  if (scopedMailbox) {
    totalQuery = totalQuery.ilike("mailbox_email", scopedMailbox);
    unlinkedQuery = unlinkedQuery.ilike("mailbox_email", scopedMailbox);
    mailboxQuery = mailboxQuery.ilike("email", scopedMailbox);
  }

  const [{ count: totalCount, error: totalErr }, { count: unlinkedCount, error: unlinkedErr }, { count: mbCount, error: mbErr }] =
    await Promise.all([totalQuery, unlinkedQuery, mailboxQuery]);

  const tableErr = totalErr || unlinkedErr || mbErr;
  if (tableErr) {
    db_error =
      tableErr.message.includes("does not exist") || tableErr.code === "42P01"
        ? "Database tables missing — run supabase/migrations/029_company_emails.sql in Supabase SQL editor"
        : tableErr.message;
  } else {
    total = totalCount || 0;
    unlinked = unlinkedCount || 0;
    mailboxCount = mbCount || 0;

    if (isSuperAdmin(req)) {
      const { data, error: runErr } = await supabase
        .from("email_sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!runErr) lastRun = data;
    }
  }

  res.json({
    total,
    unlinked,
    mailboxes: mailboxCount,
    graph_configured: graphConfigured,
    db_error,
    last_sync: lastRun,
    mailbox_email: scopedMailbox,
    scope: isSuperAdmin(req) ? "company" : "own",
  });
});

// GET /api/emails/mailboxes
router.get("/mailboxes", async (req, res) => {
  let query = supabase
    .from("mailboxes")
    .select("id, email, display_name, last_synced_at, last_sync_error, is_active")
    .eq("is_active", true)
    .order("email");

  if (!isSuperAdmin(req)) {
    const own = callerMailboxEmail(req);
    if (!own) return res.status(403).json({ error: "No mailbox email on your profile" });
    query = query.ilike("email", own);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// GET /api/emails — list with filters
router.get("/", async (req, res) => {
  const {
    search,
    mailbox,
    linked,
    category,
    lead_id,
    buyer_id,
    project_id,
    quotation_id,
    page = "1",
    limit = "50",
  } = req.query;

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit) || 50);

  let query = supabase
    .from("company_emails")
    .select(
      "id, subject, sender_name, sender_email, mailbox_email, received_at, is_read, has_attachments, direction, body_preview, email_category, lead_id, buyer_id, contact_id, project_id, quotation_id, conversation_id",
      { count: "exact" },
    );

  if (!isSuperAdmin(req)) {
    const own = callerMailboxEmail(req);
    if (!own) return res.status(403).json({ error: "No mailbox email on your profile" });
    query = query.ilike("mailbox_email", own);
  } else if (mailbox && mailbox !== "all") {
    query = query.eq("mailbox_email", String(mailbox));
  }
  if (lead_id) query = query.eq("lead_id", String(lead_id));
  if (buyer_id) query = query.eq("buyer_id", String(buyer_id));
  if (project_id) query = query.eq("project_id", String(project_id));
  if (quotation_id) query = query.eq("quotation_id", String(quotation_id));

  const categoryFilter = String(category || "all");
  if (categoryFilter === "uncategorized") {
    query = query.is("email_category", null);
  } else if (["lead", "quotation", "followup"].includes(categoryFilter)) {
    query = query.eq("email_category", categoryFilter);
  }

  if (linked === "true") {
    query = query.or(
      "lead_id.not.is.null,buyer_id.not.is.null,contact_id.not.is.null,project_id.not.is.null,quotation_id.not.is.null,email_category.not.is.null",
    );
  } else if (linked === "false") {
    query = query
      .is("lead_id", null)
      .is("buyer_id", null)
      .is("contact_id", null)
      .is("project_id", null)
      .is("quotation_id", null)
      .is("email_category", null);
  }

  if (search) {
    const s = String(search).replace(/[%_,()]/g, " ").trim();
    if (s) {
      query = query.or(
        `subject.ilike.%${s}%,sender_email.ilike.%${s}%,sender_name.ilike.%${s}%,body_preview.ilike.%${s}%`,
      );
    }
  }

  query = query.order("received_at", { ascending: false }).range((p - 1) * l, p * l - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    data: data || [],
    total: count || 0,
    page: p,
    totalPages: Math.ceil((count || 0) / l),
  });
});

// GET /api/emails/allowlist — parsed allowlist from env (verify backend loaded .env)
router.get("/allowlist", requireSuperAdmin, (_req, res) => {
  const list = getSyncAllowlist();
  res.json({
    configured: list !== null,
    names: list?.names ?? [],
    emails: list?.emails ?? [],
  });
});

// GET /api/emails/discover — Azure AD mailbox preview (debug)
router.get("/discover", requireSuperAdmin, async (_req, res) => {
  if (!isGraphConfigured()) {
    return res.status(503).json({ error: "Microsoft Graph is not configured on the server" });
  }
  try {
    const users = await discoverTenantMailboxes();
    res.json({
      total: users.length,
      included: users.filter((u) => u.included).length,
      excluded: users.filter((u) => !u.included).length,
      data: users,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discovery failed";
    res.status(500).json({ error: message });
  }
});

// POST /api/emails/sync — manual sync trigger
router.post("/sync", requireSuperAdmin, async (_req, res) => {
  if (!isGraphConfigured()) {
    return res.status(503).json({ error: "Microsoft Graph is not configured on the server" });
  }
  if (syncInProgress || isFullSignatureBackfillRunning()) {
    return res.status(409).json({ error: "Another email job is already in progress" });
  }

  syncInProgress = true;
  try {
    const result = await runEmailSync();
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    res.status(500).json({ error: message });
  } finally {
    syncInProgress = false;
  }
});

// POST /api/emails/backfill-signatures
// Re-fetch / re-parse phone+company for emails.
// body: { all?: true, force?: true, limit?: number }
router.post("/backfill-signatures", requireSuperAdmin, async (req, res) => {
  const all = Boolean(req.body?.all);
  const force = Boolean(req.body?.force ?? all);

  // Full DB run starts in background so Render HTTP timeout doesn't kill it
  if (all) {
    if (!isGraphConfigured()) {
      return res.status(503).json({ error: "Microsoft Graph is not configured on the server" });
    }
    if (syncInProgress || isFullSignatureBackfillRunning()) {
      return res.status(409).json({
        error: isFullSignatureBackfillRunning()
          ? "Full signature parse is already running"
          : "Sync already in progress — try again shortly",
      });
    }
    const started = startFullSignatureBackfill();
    return res.json({
      success: started.started,
      background: true,
      message: started.message,
    });
  }

  if (syncInProgress || isFullSignatureBackfillRunning()) {
    return res.status(409).json({ error: "Another email job is already running — try again shortly" });
  }

  syncInProgress = true;
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.body?.limit) || 300));
    const result = await backfillEmailSignatures({
      limit,
      force,
      fetchMissingBodies: isGraphConfigured(),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backfill failed";
    res.status(500).json({ error: message });
  } finally {
    syncInProgress = false;
  }
});

// POST /api/emails/purge — delete all synced emails and mailbox cache (super_admin)
router.post("/purge", requireSuperAdmin, async (_req, res) => {
  const zeroUuid = "00000000-0000-0000-0000-000000000000";

  const { count: emailCountBefore } = await supabase
    .from("company_emails")
    .select("id", { count: "exact", head: true });

  const { error: emailsErr } = await supabase
    .from("company_emails")
    .delete()
    .neq("id", zeroUuid);

  if (emailsErr) return res.status(500).json({ error: emailsErr.message });

  const { error: mbErr } = await supabase.from("mailboxes").delete().neq("id", zeroUuid);
  if (mbErr) return res.status(500).json({ error: mbErr.message });

  await supabase.from("email_sync_runs").delete().neq("id", zeroUuid);

  res.json({
    success: true,
    deleted_emails: emailCountBefore || 0,
    message: "All synced emails cleared. Run Sync now to pull fresh mail from your allowlist.",
  });
});

// GET /api/emails/:id — full detail
router.get("/:id", async (req, res) => {
  const { data: email, error } = await supabase
    .from("company_emails")
    .select("*, mailbox:mailboxes(graph_user_id, email, display_name)")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!email) return res.status(404).json({ error: "Email not found" });
  if (!canAccessMailbox(req, email.mailbox_email)) {
    return res.status(404).json({ error: "Email not found" });
  }

  if (!email.body_html && !email.body_text) {
    const graphUserId = (email.mailbox as { graph_user_id?: string })?.graph_user_id;
    if (graphUserId) {
      try {
        const body = await fetchMessageBody(graphUserId, email.graph_message_id);
        // Return body to the client only — do not store HTML in the database
        email.body_html = body.body_html;
        email.body_text = body.body_text;
      } catch (err) {
        console.error("Failed to fetch message body:", err);
      }
    }
  }

  res.json(email);
});

const linkSchema = z.object({
  lead_id: z.string().uuid().nullable().optional(),
  buyer_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  quotation_id: z.string().uuid().nullable().optional(),
});

const categorizeSchema = z.object({
  email_category: z.enum(["lead", "quotation", "followup"]).nullable(),
  lead_id: z.string().uuid().nullable().optional(),
  quotation_id: z.string().uuid().nullable().optional(),
});

// PATCH /api/emails/:id/categorize — tag as Lead / Quotation / Follow-up (all inbox users)
router.patch("/:id/categorize", async (req, res) => {
  const parsed = categorizeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid category payload" });

  const { data: existing, error: existingErr } = await supabase
    .from("company_emails")
    .select("mailbox_email")
    .eq("id", req.params.id)
    .maybeSingle();

  if (existingErr) return res.status(500).json({ error: existingErr.message });
  if (!existing) return res.status(404).json({ error: "Email not found" });
  if (!canAccessMailbox(req, existing.mailbox_email)) {
    return res.status(404).json({ error: "Email not found" });
  }

  const category = parsed.data.email_category;
  const update: Record<string, unknown> = {
    email_category: category,
    linked_by: req.user?.id || null,
    linked_at: new Date().toISOString(),
  };

  if (category === "lead") {
    update.lead_id = parsed.data.lead_id ?? null;
    update.quotation_id = null;
  } else if (category === "quotation" || category === "followup") {
    update.quotation_id = parsed.data.quotation_id ?? null;
    update.lead_id = null;
  } else {
    update.lead_id = parsed.data.lead_id ?? null;
    update.quotation_id = parsed.data.quotation_id ?? null;
  }

  const { data, error } = await supabase
    .from("company_emails")
    .update(update)
    .eq("id", req.params.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Email not found" });
  res.json(data);
});

// PATCH /api/emails/:id/link
router.patch("/:id/link", requireRole("manager", "super_admin"), async (req, res) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid link payload" });

  const { data: existing, error: existingErr } = await supabase
    .from("company_emails")
    .select("mailbox_email")
    .eq("id", req.params.id)
    .maybeSingle();

  if (existingErr) return res.status(500).json({ error: existingErr.message });
  if (!existing) return res.status(404).json({ error: "Email not found" });
  if (!canAccessMailbox(req, existing.mailbox_email)) {
    return res.status(404).json({ error: "Email not found" });
  }

  const { data, error } = await supabase
    .from("company_emails")
    .update({
      ...parsed.data,
      linked_by: req.user?.id || null,
      linked_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Email not found" });
  res.json(data);
});

// GET /api/emails/contacts-extract
// Returns unique senders enriched with phone/company parsed from signatures
router.get("/contacts-extract", requireRole("manager", "super_admin"), async (req, res) => {
  const scopedMailbox = isSuperAdmin(req) ? null : callerMailboxEmail(req);

  // Page through all rows (Supabase caps a single select at 1000).
  // Fall back to base columns if sig_phone/sig_company don't exist yet (migration not run).
  const PAGE = 1000;
  let columns = "sender_name, sender_email, sig_phone, sig_company";
  let data: Array<Record<string, unknown>> = [];

  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from("company_emails")
      .select(columns)
      .not("sender_email", "is", null)
      .neq("sender_email", "")
      .eq("direction", "inbound")
      .range(from, from + PAGE - 1);

    if (scopedMailbox) {
      query = query.ilike("mailbox_email", scopedMailbox);
    }

    const { data: page, error } = await query;
    if (error) {
      const msg = String(error.message || "");
      if (from === 0 && /sig_phone|sig_company|column/i.test(msg) && columns.includes("sig_phone")) {
        // Signature columns missing — retry without them
        columns = "sender_name, sender_email";
        from = -PAGE; // loop increment brings this back to 0
        continue;
      }
      return res.status(500).json({ error: msg });
    }

    data = data.concat((page || []) as unknown as Array<Record<string, unknown>>);
    if (!page || page.length < PAGE) break;
  }

  // Deduplicate by lower-cased email, merging best available phone/company per sender
  const map = new Map<
    string,
    { name: string | null; email: string; phone: string | null; company: string | null; count: number }
  >();

  for (const row of data) {
    const email = String(row.sender_email || "");
    if (!email) continue;
    const key = email.toLowerCase();
    const name = row.sender_name ? String(row.sender_name) : null;
    const phone = row.sig_phone ? String(row.sig_phone) : null;
    const company =
      (row.sig_company ? String(row.sig_company) : null) ||
      guessCompanyFromSender(name, email);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { name, email, phone, company, count: 1 });
    } else {
      existing.count += 1;
      if (!existing.phone && phone) existing.phone = phone;
      if (!existing.company && company) existing.company = company;
      if (!existing.name && name) existing.name = name;
    }
  }

  // Check which emails already exist as contacts (chunked — the list can be large)
  const allEmails = [...map.keys()];
  const existingContacts = new Set<string>();
  for (let i = 0; i < allEmails.length; i += 500) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("email")
      .in("email", allEmails.slice(i, i + 500));
    for (const c of contacts || []) {
      if (c.email) existingContacts.add((c.email as string).toLowerCase());
    }
  }

  const results = [...map.values()]
    .map((r) => ({ ...r, already_contact: existingContacts.has(r.email.toLowerCase()) }))
    .sort((a, b) => b.count - a.count);

  res.json({ data: results, total: results.length });
});

// POST /api/emails/contacts-extract/import
// Bulk-import selected email senders as contacts
router.post(
  "/contacts-extract/import",
  requireRole("manager", "super_admin"),
  async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const items = req.body?.contacts;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "contacts array is required" });
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of items) {
      const email = String(item.email || "").trim().toLowerCase();
      if (!email) { skipped++; continue; }

      // Skip if already a contact
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .ilike("email", email)
        .maybeSingle();

      if (existing) { skipped++; continue; }

      const { error } = await supabase.from("contacts").insert({
        full_name: String(item.name || email).trim(),
        email,
        phone: item.phone ? String(item.phone).trim() : null,
        company: item.company ? String(item.company).trim() : null,
        created_by: userId,
      });

      if (error) {
        errors.push(`${email}: ${error.message}`);
      } else {
        imported++;
      }
    }

    res.json({ imported, skipped, errors });
  },
);

export function registerEmailRoutes(api: express.Router) {
  api.use("/emails", router);
}

/** Cron / internal trigger — protected by shared secret header */
export function registerEmailSyncInternalRoute(api: express.Router) {
  api.post("/internal/emails/sync", async (req, res) => {
    const secret = process.env.EMAIL_SYNC_CRON_SECRET;
    if (!secret || req.headers["x-cron-secret"] !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!isGraphConfigured()) {
      return res.status(503).json({ error: "Microsoft Graph is not configured" });
    }
    if (syncInProgress) {
      return res.status(409).json({ error: "Sync already in progress" });
    }

    syncInProgress = true;
    try {
      const result = await runEmailSync();
      res.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sync failed";
      res.status(500).json({ error: message });
    } finally {
      syncInProgress = false;
    }
  });
}
