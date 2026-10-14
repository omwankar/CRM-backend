import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { normalizeAppRole } from "../lib/roles.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

const CLOSED = ["won_closed", "lost_closed"];

const createSchema = z.object({
  title: z.string().trim().optional().nullable(),
  requirement: z.string().trim().min(10),
  standalone_project_name: z.string().trim().optional().nullable(),
  prospect_name: z.string().trim().optional().nullable(),
  client_email: z.string().email().optional().nullable().or(z.literal("").transform(() => null)),
  client_budget: z.number().optional().nullable(),
  client_currency: z.string().trim().optional().nullable(),
  deadline: z.string().optional().nullable(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  notes: z.string().optional().nullable(),
});

async function isOperationsMember(userId: string, role?: string) {
  if (normalizeAppRole(role) === "super_admin") return { ok: true, superAdmin: true };
  const { data } = await supabase.from("users").select("in_operations").eq("id", userId).maybeSingle();
  return { ok: Boolean(data?.in_operations), superAdmin: false };
}

async function requireOperations(req: express.Request, res: express.Response) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const access = await isOperationsMember(userId, req.user?.role);
  if (!access.ok) {
    res.status(403).json({ error: "Operations pipeline is only for the operations team." });
    return null;
  }
  return { userId, superAdmin: access.superAdmin };
}

async function ensureQuotation(enquiry: Record<string, any>, userId: string) {
  const { data: existing } = await supabase
    .from("quotations")
    .select("id, quotation_number")
    .eq("enquiry_id", enquiry.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing;

  const requirement = String(enquiry.requirement || "").trim();
  const payload: Record<string, unknown> = {
    requirement: requirement.length >= 10 ? requirement : `${requirement} freight enquiry`.padEnd(10, "."),
    status: "waiting_from_companies",
    enquiry_lead: enquiry.owner_id || userId,
    project_id: enquiry.project_id,
    standalone_project_name: enquiry.standalone_project_name,
    client_budget: enquiry.client_budget,
    client_currency: enquiry.client_currency || "GBP",
    client_price_notes: enquiry.client_price_notes,
    deadline: enquiry.deadline,
    enquiry_title: enquiry.title || enquiry.prospect_name || enquiry.standalone_project_name,
    enquiry_stage: enquiry.stage === "new_enquiry" || enquiry.stage === "under_review" ? "preparing" : enquiry.stage,
    priority: enquiry.priority || "medium",
    buyer_id: enquiry.buyer_id,
    client_email: enquiry.client_email,
    enquiry_id: enquiry.id,
    created_by: userId,
    updated_by: userId,
  };

  const { data, error } = await supabase.from("quotations").insert(payload).select("id, quotation_number").single();
  if (error || !data) throw new Error(error?.message || "Could not create the quotation");

  if (enquiry.stage === "new_enquiry" || enquiry.stage === "under_review") {
    await supabase.from("enquiries").update({ stage: "preparing", updated_by: userId }).eq("id", enquiry.id);
  }
  return data;
}

// GET /api/operations/pipeline
router.get("/pipeline", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const [{ data: members }, { data: enquiries, error }] = await Promise.all([
    supabase.from("users").select("id, full_name").eq("in_operations", true).eq("is_active", true).order("full_name"),
    supabase
      .from("enquiries")
      .select("id, enquiry_number, title, requirement, stage, created_at, prospect_name, client_currency, standalone_project_name")
      .neq("stage", "won_closed")
      .neq("stage", "lost_closed")
      .order("created_at", { ascending: true })
      .limit(150),
  ]);

  if (error) return res.status(500).json({ error: error.message });

  const rows = enquiries || [];
  const ids = rows.map((row) => row.id);
  let operators: Array<{ enquiry_id: string; user_id: string; status: string }> = [];
  let sends: Array<Record<string, any>> = [];
  if (ids.length) {
    const [opRes, sendRes] = await Promise.all([
      supabase.from("enquiry_operators").select("enquiry_id, user_id, status, joined_at").in("enquiry_id", ids),
      supabase.from("enquiry_agent_sends").select("*").in("enquiry_id", ids).order("sent_at", { ascending: true }),
    ]);
    if (opRes.error) return res.status(500).json({ error: opRes.error.message });
    if (sendRes.error) return res.status(500).json({ error: sendRes.error.message });
    operators = opRes.data || [];
    sends = sendRes.data || [];
  }

  const nameIds = new Set<string>([
    ...(members || []).map((m) => m.id),
    ...operators.map((o) => o.user_id),
    ...sends.map((s) => s.user_id),
  ]);
  let names: Record<string, string> = {};
  if (nameIds.size) {
    const { data: people } = await supabase.from("users").select("id, full_name").in("id", Array.from(nameIds));
    names = (people || []).reduce((acc: Record<string, string>, person) => {
      acc[person.id] = person.full_name || "Operations";
      return acc;
    }, {});
  }

  const openIds = new Set(ids);
  const workloadMap = new Map<string, { user_id: string; full_name: string; open_count: number }>();
  for (const member of members || []) {
    workloadMap.set(member.id, { user_id: member.id, full_name: member.full_name || "Operations", open_count: 0 });
  }
  for (const op of operators) {
    if (!openIds.has(op.enquiry_id)) continue;
    const current = workloadMap.get(op.user_id) || {
      user_id: op.user_id,
      full_name: names[op.user_id] || "Operations",
      open_count: 0,
    };
    current.open_count += 1;
    workloadMap.set(op.user_id, current);
  }

  const inquiries = rows.map((row) => ({
    ...row,
    operators: operators
      .filter((op) => op.enquiry_id === row.id)
      .map((op) => ({
        user_id: op.user_id,
        full_name: names[op.user_id] || "Operations",
        status: op.status,
      })),
    sends: sends
      .filter((send) => send.enquiry_id === row.id)
      .map((send) => ({
        ...send,
        user_name: names[send.user_id] || "Operations",
      })),
  }));

  res.json({
    workload: Array.from(workloadMap.values()).sort((a, b) => b.open_count - a.open_count || a.full_name.localeCompare(b.full_name)),
    inquiries,
    viewer_is_super_admin: access.superAdmin,
  });
});

// POST /api/operations/enquiries — paste inbox creates a real enquiry and starts work
router.post("/enquiries", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });

  const { data, error } = await supabase
    .from("enquiries")
    .insert({
      ...parsed.data,
      stage: "new_enquiry",
      owner_id: access.userId,
      created_by: access.userId,
      updated_by: access.userId,
    })
    .select("id, enquiry_number, title, created_at")
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || "Could not create the enquiry" });

  await supabase.from("enquiry_operators").insert({
    enquiry_id: data.id,
    user_id: access.userId,
    status: "working",
  });

  res.status(201).json(data);
});

// POST /api/operations/enquiries/:id/join
router.post("/enquiries/:id/join", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const { data: enquiry } = await supabase.from("enquiries").select("id, stage").eq("id", req.params.id).maybeSingle();
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  if (CLOSED.includes(enquiry.stage)) return res.status(400).json({ error: "This enquiry is already closed" });

  const { error } = await supabase.from("enquiry_operators").upsert(
    { enquiry_id: enquiry.id, user_id: access.userId, status: "working" },
    { onConflict: "enquiry_id,user_id", ignoreDuplicates: true },
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/operations/enquiries/:id/agents
router.post("/enquiries/:id/agents", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const parsed = z.object({
    agent_name: z.string().trim().min(2),
    vendor_id: z.string().uuid().optional().nullable(),
    currency: z.string().trim().optional().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the agent name" });

  const { data: enquiry } = await supabase.from("enquiries").select("id, stage, client_currency").eq("id", req.params.id).maybeSingle();
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });

  await supabase.from("enquiry_operators").upsert(
    { enquiry_id: enquiry.id, user_id: access.userId, status: "working" },
    { onConflict: "enquiry_id,user_id", ignoreDuplicates: true },
  );

  const { data, error } = await supabase
    .from("enquiry_agent_sends")
    .insert({
      enquiry_id: enquiry.id,
      user_id: access.userId,
      agent_name: parsed.data.agent_name,
      vendor_id: parsed.data.vendor_id || null,
      currency: parsed.data.currency || enquiry.client_currency || "GBP",
    })
    .select("*")
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || "Could not add the agent" });
  res.status(201).json(data);
});

// PUT /api/operations/agents/:id — record the rate
router.put("/agents/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const parsed = z.object({
    quoted_price: z.number().positive(),
    currency: z.string().trim().optional().nullable(),
    notes: z.string().optional().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the rate you received" });

  const { data: send } = await supabase.from("enquiry_agent_sends").select("*").eq("id", req.params.id).maybeSingle();
  if (!send) return res.status(404).json({ error: "Agent send not found" });
  if (send.user_id !== access.userId && !access.superAdmin) {
    return res.status(403).json({ error: "You can only update the agents you sent" });
  }

  const { data, error } = await supabase
    .from("enquiry_agent_sends")
    .update({
      quoted_price: parsed.data.quoted_price,
      currency: parsed.data.currency || send.currency,
      notes: parsed.data.notes ?? send.notes,
    })
    .eq("id", send.id)
    .select("*")
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || "Could not save the rate" });

  if (send.vendor_quote_id) {
    await supabase
      .from("quotation_vendor_quotes")
      .update({
        quoted_price: parsed.data.quoted_price,
        currency: parsed.data.currency || send.currency,
      })
      .eq("id", send.vendor_quote_id);
  }

  res.json(data);
});

// POST /api/operations/agents/:id/best — this person's best rate becomes the enquiry's chosen quote
router.post("/agents/:id/best", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const { data: send } = await supabase.from("enquiry_agent_sends").select("*").eq("id", req.params.id).maybeSingle();
  if (!send) return res.status(404).json({ error: "Agent send not found" });
  if (send.user_id !== access.userId && !access.superAdmin) {
    return res.status(403).json({ error: "You can only choose a quote you received" });
  }
  if (send.quoted_price == null) return res.status(400).json({ error: "Enter the rate before choosing it" });

  const { data: enquiry } = await supabase.from("enquiries").select("*").eq("id", send.enquiry_id).maybeSingle();
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });

  const { data: actor } = await supabase.from("users").select("full_name").eq("id", send.user_id).maybeSingle();
  const who = actor?.full_name || "Operations";

  let quotation;
  try {
    quotation = await ensureQuotation(enquiry, access.userId);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Could not open a quotation" });
  }

  const note = [`Selected by ${who}`, send.notes].filter(Boolean).join(" — ");
  let vendorQuoteId = send.vendor_quote_id as string | null;

  if (vendorQuoteId) {
    const { error } = await supabase
      .from("quotation_vendor_quotes")
      .update({
        quoted_price: send.quoted_price,
        currency: send.currency || enquiry.client_currency || "GBP",
        vendor_name: send.agent_name,
        notes: note,
        logged_by: send.user_id,
        quote_received_at: new Date().toISOString(),
      })
      .eq("id", vendorQuoteId);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    const { data: created, error } = await supabase
      .from("quotation_vendor_quotes")
      .insert({
        quotation_id: quotation.id,
        vendor_id: send.vendor_id,
        vendor_name: send.agent_name,
        quoted_price: send.quoted_price,
        currency: send.currency || enquiry.client_currency || "GBP",
        quote_received_at: new Date().toISOString(),
        notes: note,
        logged_by: send.user_id,
        is_chosen: false,
      })
      .select("id")
      .single();
    if (error || !created) return res.status(500).json({ error: error?.message || "Could not save the quote" });
    vendorQuoteId = created.id;
  }

  await supabase.from("enquiry_agent_sends").update({ is_best: false }).eq("enquiry_id", send.enquiry_id).eq("user_id", send.user_id);
  await supabase.from("enquiry_agent_sends").update({ is_best: true, vendor_quote_id: vendorQuoteId }).eq("id", send.id);

  await supabase.from("quotation_vendor_quotes").update({ is_chosen: false }).eq("quotation_id", quotation.id);
  await supabase
    .from("quotation_vendor_quotes")
    .update({ is_chosen: true, quote_line_status: "finalised" })
    .eq("id", vendorQuoteId);
  await supabase.from("quotations").update({ chosen_quote_id: vendorQuoteId, updated_by: access.userId }).eq("id", quotation.id);

  await supabase.from("enquiry_operators").update({ status: "quoted" }).eq("enquiry_id", send.enquiry_id).eq("user_id", send.user_id);

  res.json({ ok: true, quotation_id: quotation.id, vendor_quote_id: vendorQuoteId, enquiry_number: enquiry.enquiry_number });
});

export function registerOperationsRoutes(api: express.Router) {
  api.use("/operations", router);
}
