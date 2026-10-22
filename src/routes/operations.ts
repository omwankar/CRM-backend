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
  enquiry_number: z.string().trim().min(3).max(80).optional().nullable(),
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
  customer_contact: z.string().trim().optional().nullable(),
  customer_phone: z.string().trim().optional().nullable(),
  user_ids: z.array(z.string().uuid()).optional(),
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

function hasQuote(send: { quoted_price?: number | null; notes?: string | null; is_best?: boolean }) {
  return send.quoted_price != null || Boolean(String(send.notes || "").trim());
}

function columnFor(sends: Array<{ quoted_price?: number | null; notes?: string | null; is_best?: boolean }>) {
  if (!sends.length) return "to_send";
  if (sends.some((send) => send.is_best)) return "best_selected";
  if (sends.some((send) => hasQuote(send))) return "choose_best";
  return "waiting";
}

function firstAmount(text: string) {
  const match = String(text || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function routeLine(row: { title?: string | null; requirement?: string | null }) {
  const line = String(row.requirement || "").split("\n").map((part) => part.trim()).find(Boolean);
  return line || row.title || "";
}

async function operationsEnquiryIds() {
  const flagged = await supabase.from("enquiries").select("id").eq("in_operations", true);
  if (!flagged.error) return (flagged.data || []).map((row) => row.id);
  const ops = await supabase.from("enquiry_operators").select("enquiry_id");
  return Array.from(new Set((ops.data || []).map((row) => row.enquiry_id)));
}

async function deleteOperationsEnquiryById(enquiryId: string) {
  const { data: quotes } = await supabase.from("quotations").select("id").eq("enquiry_id", enquiryId);
  const quoteIds = (quotes || []).map((row) => row.id);
  if (quoteIds.length) {
    const removedQuotes = await supabase.from("quotation_vendor_quotes").delete().in("quotation_id", quoteIds);
    if (removedQuotes.error) throw new Error(removedQuotes.error.message);
    const removed = await supabase.from("quotations").delete().in("id", quoteIds);
    if (removed.error) throw new Error(removed.error.message);
  }
  await supabase.from("enquiry_updates").delete().eq("enquiry_id", enquiryId);
  await supabase.from("enquiry_agent_sends").delete().eq("enquiry_id", enquiryId);
  await supabase.from("enquiry_operators").delete().eq("enquiry_id", enquiryId);
  const { error } = await supabase.from("enquiries").delete().eq("id", enquiryId);
  if (error) throw new Error(error.message);
}

async function rememberCustomer(company?: string | null, contact?: string | null, email?: string | null, phone?: string | null) {
  const name = String(company || "").trim();
  if (name.length < 2) return;
  const lookup = await supabase.from("operations_customers").select("id, contact_name, email, phone").ilike("company_name", name).limit(1);
  if (lookup.error) return;
  const row = lookup.data?.[0];
  const next = {
    contact_name: contact || row?.contact_name || null,
    email: email || row?.email || null,
    phone: phone || row?.phone || null,
  };
  if (row) {
    await supabase.from("operations_customers").update(next).eq("id", row.id);
    return;
  }
  await supabase.from("operations_customers").insert({ company_name: name, ...next });
}

// GET /api/operations/pipeline
router.get("/pipeline", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const includeClosed = req.query.closed === "1";
  const opsIds = await operationsEnquiryIds();
  let enquiryQuery = supabase
    .from("enquiries")
    .select("id, enquiry_number, title, requirement, stage, created_at, created_by, prospect_name, client_email, client_currency, standalone_project_name, client_price_notes, outcome, notes")
    .order("created_at", { ascending: false })
    .limit(200);
  if (opsIds.length) enquiryQuery = enquiryQuery.in("id", opsIds);
  else enquiryQuery = enquiryQuery.eq("id", "00000000-0000-0000-0000-000000000000");
  if (!includeClosed) {
    enquiryQuery = enquiryQuery.neq("stage", "won_closed").neq("stage", "lost_closed");
  }

  const [{ data: members }, { data: enquiries, error }] = await Promise.all([
    supabase.from("users").select("id, full_name").eq("in_operations", true).eq("is_active", true).order("full_name"),
    enquiryQuery,
  ]);
  const directoryQuery = await supabase.from("operations_agents").select("id, company_name, contact_name, email, phone, created_at").order("company_name");
  const customersQuery = await supabase.from("operations_customers").select("id, company_name, contact_name, email, phone, created_at").order("company_name");
  const directoryFallback = directoryQuery.error && /phone/i.test(directoryQuery.error.message || "")
    ? await supabase.from("operations_agents").select("id, company_name, contact_name, email, created_at").order("company_name")
    : null;
  const directory = directoryFallback ? (directoryFallback.data || []).map((row) => ({ ...row, phone: null as string | null })) : directoryQuery.data;
  const directoryError = directoryFallback ? directoryFallback.error : directoryQuery.error;

  if (error) return res.status(500).json({ error: error.message });
  if (directoryError) return res.status(500).json({ error: directoryError.message });
  const customers = customersQuery.error ? [] : customersQuery.data || [];

  const rows = enquiries || [];
  const ids = rows.map((row) => row.id);
  let operators: Array<{ enquiry_id: string; user_id: string; status: string; joined_at: string }> = [];
  let sends: Array<Record<string, any>> = [];
  let updates: Array<Record<string, any>> = [];
  if (ids.length) {
    const [opRes, sendRes, updateRes] = await Promise.all([
      supabase.from("enquiry_operators").select("enquiry_id, user_id, status, joined_at").in("enquiry_id", ids),
      supabase.from("enquiry_agent_sends").select("*").in("enquiry_id", ids).order("sent_at", { ascending: true }),
      supabase.from("enquiry_updates").select("id, enquiry_id, user_id, body, created_at").in("enquiry_id", ids).order("created_at", { ascending: false }),
    ]);
    if (opRes.error) return res.status(500).json({ error: opRes.error.message });
    if (sendRes.error) return res.status(500).json({ error: sendRes.error.message });
    if (updateRes.error) return res.status(500).json({ error: updateRes.error.message });
    operators = opRes.data || [];
    sends = sendRes.data || [];
    updates = updateRes.data || [];
  }

  const nameIds = new Set<string>([
    ...(members || []).map((m) => m.id),
    ...operators.map((o) => o.user_id),
    ...sends.map((s) => s.user_id),
    ...updates.map((u) => u.user_id).filter(Boolean),
    ...rows.map((row) => row.created_by).filter(Boolean),
  ]);
  let names: Record<string, string> = {};
  if (nameIds.size) {
    const { data: people } = await supabase.from("users").select("id, full_name").in("id", Array.from(nameIds));
    names = (people || []).reduce((acc: Record<string, string>, person) => {
      acc[person.id] = person.full_name || "Operations";
      return acc;
    }, {});
  }

  const openRows = rows.filter((row) => !CLOSED.includes(row.stage));
  const openIds = new Set(openRows.map((row) => row.id));
  const rank = new Map(openRows.map((row, index) => [row.id, index + 1]));

  const workloadMap = new Map<string, { user_id: string; full_name: string; open_count: number; rates_awaited: number }>();
  for (const member of members || []) {
    workloadMap.set(member.id, {
      user_id: member.id,
      full_name: member.full_name || "Operations",
      open_count: 0,
      rates_awaited: 0,
    });
  }

  const inquiries = rows.map((row) => {
    const rowSends = sends.filter((send) => send.enquiry_id === row.id);
    const rowOps = operators.filter((op) => op.enquiry_id === row.id);
    return {
      ...row,
      route: routeLine(row),
      column: CLOSED.includes(row.stage) ? "closed" : columnFor(rowSends),
      priority_rank: rank.get(row.id) ?? null,
      rates_sent: rowSends.length,
      rates_received: rowSends.filter((send) => hasQuote(send)).length,
      operators: rowOps.map((op) => ({
        user_id: op.user_id,
        full_name: names[op.user_id] || "Operations",
        status: op.status,
      })),
      sends: rowSends.map((send) => ({
        ...send,
        user_name: names[send.user_id] || "Operations",
      })),
      updates: updates
        .filter((update) => update.enquiry_id === row.id)
        .map((update) => ({
          ...update,
          user_name: names[update.user_id] || "Operations",
        })),
    };
  });

  for (const inquiry of inquiries) {
    if (!openIds.has(inquiry.id)) continue;
    for (const op of inquiry.operators) {
      const current = workloadMap.get(op.user_id) || {
        user_id: op.user_id,
        full_name: op.full_name,
        open_count: 0,
        rates_awaited: 0,
      };
      current.open_count += 1;
      const own = (inquiry.sends as unknown as Array<{ user_id: string; quoted_price?: number | null }>).filter((send) => send.user_id === op.user_id);
      if (!own.some((send) => hasQuote(send))) current.rates_awaited += 1;
      workloadMap.set(op.user_id, current);
    }
  }

  const numberById = new Map(rows.map((row) => [row.id, row.enquiry_number]));
  const activity: Array<{ id: string; at: string; user_id: string | null; user_name: string; enquiry_id: string; enquiry_number: string; text: string }> = [];
  for (const row of rows) {
    activity.push({
      id: `created-${row.id}`,
      at: row.created_at,
      user_id: row.created_by,
      user_name: names[row.created_by] || "Operations",
      enquiry_id: row.id,
      enquiry_number: row.enquiry_number,
      text: "created the inquiry",
    });
  }
  for (const op of operators) {
    activity.push({
      id: `join-${op.enquiry_id}-${op.user_id}`,
      at: op.joined_at,
      user_id: op.user_id,
      user_name: names[op.user_id] || "Operations",
      enquiry_id: op.enquiry_id,
      enquiry_number: numberById.get(op.enquiry_id) || "",
      text: "started work",
    });
  }
  for (const send of sends) {
    activity.push({
      id: `send-${send.id}`,
      at: send.sent_at,
      user_id: send.user_id,
      user_name: names[send.user_id] || "Operations",
      enquiry_id: send.enquiry_id,
      enquiry_number: numberById.get(send.enquiry_id) || "",
      text: `contacted ${send.agent_name}`,
    });
    if (hasQuote(send)) {
      activity.push({
        id: `rate-${send.id}`,
        at: send.quoted_at || send.sent_at,
        user_id: send.user_id,
        user_name: names[send.user_id] || "Operations",
        enquiry_id: send.enquiry_id,
        enquiry_number: numberById.get(send.enquiry_id) || "",
        text: `got a quote from ${send.agent_name}`,
      });
    }
    if (send.is_best) {
      activity.push({
        id: `best-${send.id}`,
        at: send.chosen_at || send.quoted_at || send.sent_at,
        user_id: send.user_id,
        user_name: names[send.user_id] || "Operations",
        enquiry_id: send.enquiry_id,
        enquiry_number: numberById.get(send.enquiry_id) || "",
        text: `chose ${send.agent_name} as best quote`,
      });
    }
  }
  for (const update of updates) {
    activity.push({
      id: `update-${update.id}`,
      at: update.created_at,
      user_id: update.user_id,
      user_name: names[update.user_id] || "Operations",
      enquiry_id: update.enquiry_id,
      enquiry_number: numberById.get(update.enquiry_id) || "",
      text: `posted: ${update.body}`,
    });
  }
  activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const agentStats = (directory || []).map((agent) => {
    const matched = sends.filter((send) => String(send.agent_name || "").trim().toLowerCase() === String(agent.company_name || "").trim().toLowerCase());
    return {
      ...agent,
      requests: matched.length,
      rates: matched.filter((send) => hasQuote(send)).length,
      chosen: matched.filter((send) => send.is_best).length,
    };
  });

  const customerStats = customers.map((customer) => {
    const company = String(customer.company_name || "").trim().toLowerCase();
    const mail = String(customer.email || "").trim().toLowerCase();
    const matched = inquiries.filter((inquiry) => {
      const names = [inquiry.standalone_project_name, inquiry.prospect_name].map((value) => String(value || "").trim().toLowerCase());
      const email = String((inquiry as { client_email?: string | null }).client_email || "").trim().toLowerCase();
      return (company && names.some((name) => name === company || name.includes(company))) || (mail && email === mail);
    });
    return { ...customer, inquiries: matched.length };
  });

  res.json({
    workload: Array.from(workloadMap.values()).sort((a, b) => b.open_count - a.open_count || a.full_name.localeCompare(b.full_name)),
    inquiries,
    activity,
    agents: agentStats,
    customers: customerStats,
    viewer_is_super_admin: access.superAdmin,
  });
});

// POST /api/operations/enquiries — paste inbox creates a real enquiry and starts work
router.post("/enquiries", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });

  const { user_ids, customer_phone, customer_contact, ...fields } = parsed.data;
  const payload: Record<string, unknown> = {
    ...fields,
    stage: "new_enquiry",
    in_operations: true,
    owner_id: access.userId,
    created_by: access.userId,
    updated_by: access.userId,
  };
  if (!fields.enquiry_number) delete payload.enquiry_number;

  let inserted = await supabase
    .from("enquiries")
    .insert(payload)
    .select("id, enquiry_number, title, created_at")
    .single();
  if (inserted.error && /in_operations/i.test(inserted.error.message || "")) {
    const { in_operations: _flag, ...withoutFlag } = payload;
    inserted = await supabase.from("enquiries").insert(withoutFlag).select("id, enquiry_number, title, created_at").single();
  }
  const { data, error } = inserted;

  if (error || !data) {
    if (/enquiry_number|duplicate|unique/i.test(error?.message || "")) {
      return res.status(409).json({ error: "That inquiry ID already exists. Edit it, or open the existing inquiry." });
    }
    return res.status(500).json({ error: error?.message || "Could not create the enquiry" });
  }

  const assignees = Array.from(new Set([access.userId, ...(user_ids || [])]));
  await supabase.from("enquiry_operators").upsert(
    assignees.map((userId) => ({ enquiry_id: data.id, user_id: userId, status: "working" })),
    { onConflict: "enquiry_id,user_id", ignoreDuplicates: true },
  );
  await rememberCustomer(fields.standalone_project_name, customer_contact, fields.client_email, customer_phone);

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

// PUT /api/operations/enquiries/:id/assignees — super admin picks who works this inquiry
router.put("/enquiries/:id/assignees", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  if (!access.superAdmin) return res.status(403).json({ error: "Only a super admin can choose who works an inquiry" });

  const parsed = z.object({ user_ids: z.array(z.string().uuid()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose the people for this inquiry" });

  const { data: enquiry } = await supabase.from("enquiries").select("id, stage").eq("id", req.params.id).maybeSingle();
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  if (CLOSED.includes(enquiry.stage)) return res.status(400).json({ error: "This enquiry is already closed" });

  const userIds = Array.from(new Set(parsed.data.user_ids));
  const { data: existing, error: existingError } = await supabase
    .from("enquiry_operators")
    .select("user_id")
    .eq("enquiry_id", enquiry.id);
  if (existingError) return res.status(500).json({ error: existingError.message });

  const keep = new Set(userIds);
  const remove = (existing || []).map((row) => row.user_id).filter((id) => !keep.has(id));
  if (remove.length) {
    const removed = await supabase.from("enquiry_operators").delete().eq("enquiry_id", enquiry.id).in("user_id", remove);
    if (removed.error) return res.status(500).json({ error: removed.error.message });
  }
  if (userIds.length) {
    const saved = await supabase.from("enquiry_operators").upsert(
      userIds.map((userId) => ({ enquiry_id: enquiry.id, user_id: userId, status: "working" })),
      { onConflict: "enquiry_id,user_id", ignoreDuplicates: true },
    );
    if (saved.error) return res.status(500).json({ error: saved.error.message });
  }
  res.json({ ok: true, user_ids: userIds });
});

// POST /api/operations/enquiries/:id/agents
router.post("/enquiries/:id/agents", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const parsed = z.object({
    agent_name: z.string().trim().min(2).optional(),
    contact_name: z.string().trim().optional().nullable(),
    contact_email: z.string().trim().optional().nullable(),
    contact_phone: z.string().trim().optional().nullable(),
    saved_agent_ids: z.array(z.string().uuid()).optional(),
    vendor_id: z.string().uuid().optional().nullable(),
    currency: z.string().trim().optional().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the agent name" });

  const { data: enquiry } = await supabase.from("enquiries").select("id, stage, client_currency").eq("id", req.params.id).maybeSingle();
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  if (CLOSED.includes(enquiry.stage)) return res.status(400).json({ error: "This enquiry is already closed" });

  await supabase.from("enquiry_operators").upsert(
    { enquiry_id: enquiry.id, user_id: access.userId, status: "working" },
    { onConflict: "enquiry_id,user_id", ignoreDuplicates: true },
  );

  const toAdd: Array<{ agent_name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null }> = [];
  if (parsed.data.saved_agent_ids?.length) {
    const savedQuery = await supabase
      .from("operations_agents")
      .select("company_name, contact_name, email, phone")
      .in("id", parsed.data.saved_agent_ids);
    const savedFallback = savedQuery.error && /phone/i.test(savedQuery.error.message || "")
      ? await supabase.from("operations_agents").select("company_name, contact_name, email").in("id", parsed.data.saved_agent_ids)
      : null;
    const saved = savedFallback ? (savedFallback.data || []).map((row) => ({ ...row, phone: null as string | null })) : savedQuery.data;
    const error = savedFallback ? savedFallback.error : savedQuery.error;
    if (error) return res.status(500).json({ error: error.message });
    for (const agent of saved || []) {
      toAdd.push({
        agent_name: agent.company_name,
        contact_name: agent.contact_name,
        contact_email: agent.email,
        contact_phone: agent.phone,
      });
    }
  }
  if (parsed.data.agent_name) {
    toAdd.push({
      agent_name: parsed.data.agent_name,
      contact_name: parsed.data.contact_name || null,
      contact_email: parsed.data.contact_email || null,
      contact_phone: parsed.data.contact_phone || null,
    });
  }
  if (!toAdd.length) return res.status(400).json({ error: "Enter the agent name" });

  const created = [];
  for (const agent of toAdd) {
    await rememberAgent(agent.agent_name, agent.contact_name, agent.contact_email, agent.contact_phone);
    const payload = {
      enquiry_id: enquiry.id,
      user_id: access.userId,
      agent_name: agent.agent_name,
      contact_name: agent.contact_name,
      contact_email: agent.contact_email,
      contact_phone: agent.contact_phone,
      vendor_id: parsed.data.vendor_id || null,
      currency: parsed.data.currency || enquiry.client_currency || "GBP",
    };
    let result = await supabase.from("enquiry_agent_sends").insert(payload).select("*").single();
    if (result.error && /contact_phone/i.test(result.error.message || "")) {
      const { contact_phone: _phone, ...withoutPhone } = payload;
      result = await supabase.from("enquiry_agent_sends").insert(withoutPhone).select("*").single();
    }
    const { data, error } = result;
    if (error || !data) return res.status(500).json({ error: error?.message || "Could not add the agent" });
    created.push(data);
  }

  res.status(201).json(created.length === 1 ? created[0] : created);
});

async function rememberAgent(company: string, contact?: string | null, email?: string | null, phone?: string | null) {
  const name = company.trim();
  if (name.length < 2) return;
  const lookup = await supabase.from("operations_agents").select("id, contact_name, email, phone").ilike("company_name", name).limit(1);
  const existing = lookup.error && /phone/i.test(lookup.error.message || "")
    ? await supabase.from("operations_agents").select("id, contact_name, email").ilike("company_name", name).limit(1)
    : null;
  const row = (existing ? existing.data : lookup.data)?.[0] as { id: string; contact_name?: string | null; email?: string | null; phone?: string | null } | undefined;
  const next = {
    contact_name: contact || row?.contact_name || null,
    email: email || row?.email || null,
    phone: phone || row?.phone || null,
  };
  if (row) {
    const updated = await supabase.from("operations_agents").update(next).eq("id", row.id);
    if (updated.error && /phone/i.test(updated.error.message || "")) {
      await supabase.from("operations_agents").update({ contact_name: next.contact_name, email: next.email }).eq("id", row.id);
    }
    return;
  }
  const inserted = await supabase.from("operations_agents").insert({ company_name: name, ...next });
  if (inserted.error && /phone/i.test(inserted.error.message || "")) {
    await supabase.from("operations_agents").insert({ company_name: name, contact_name: next.contact_name, email: next.email });
  }
}

// PUT /api/operations/agents/:id — record the rate
router.put("/agents/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;

  const parsed = z.object({
    quoted_price: z.number().positive().optional().nullable(),
    currency: z.string().trim().optional().nullable(),
    notes: z.string().optional().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Paste the quote you received" });
  const quoteText = parsed.data.notes ?? undefined;
  const amount = parsed.data.quoted_price ?? (quoteText ? firstAmount(quoteText) : null);
  if (amount == null && !String(quoteText || "").trim()) return res.status(400).json({ error: "Paste the quote you received" });

  const { data: send } = await supabase.from("enquiry_agent_sends").select("*").eq("id", req.params.id).maybeSingle();
  if (!send) return res.status(404).json({ error: "Agent send not found" });
  if (send.user_id !== access.userId && !access.superAdmin) {
    return res.status(403).json({ error: "You can only update the agents you sent" });
  }

  const { data, error } = await supabase
    .from("enquiry_agent_sends")
    .update({
      quoted_price: amount,
      currency: parsed.data.currency || send.currency,
      notes: quoteText !== undefined ? quoteText : send.notes,
      quoted_at: new Date().toISOString(),
    })
    .eq("id", send.id)
    .select("*")
    .single();

  if (error || !data) return res.status(500).json({ error: error?.message || "Could not save the rate" });

  if (send.vendor_quote_id) {
    await supabase
      .from("quotation_vendor_quotes")
      .update({
        quoted_price: amount,
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
  if (send.quoted_price == null && !String(send.notes || "").trim()) {
    return res.status(400).json({ error: "Paste the quote before choosing it" });
  }
  if (send.quoted_price == null) {
    const amount = firstAmount(send.notes || "") || 1;
    await supabase.from("enquiry_agent_sends").update({ quoted_price: amount }).eq("id", send.id);
    send.quoted_price = amount;
  }

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
  await supabase.from("enquiry_agent_sends").update({
    is_best: true,
    vendor_quote_id: vendorQuoteId,
    chosen_at: new Date().toISOString(),
  }).eq("id", send.id);

  await supabase.from("quotation_vendor_quotes").update({ is_chosen: false }).eq("quotation_id", quotation.id);
  await supabase
    .from("quotation_vendor_quotes")
    .update({ is_chosen: true, quote_line_status: "finalised" })
    .eq("id", vendorQuoteId);
  await supabase.from("quotations").update({ chosen_quote_id: vendorQuoteId, updated_by: access.userId }).eq("id", quotation.id);

  await supabase.from("enquiry_operators").update({ status: "quoted" }).eq("enquiry_id", send.enquiry_id).eq("user_id", send.user_id);

  res.json({ ok: true, quotation_id: quotation.id, vendor_quote_id: vendorQuoteId, enquiry_number: enquiry.enquiry_number });
});

const directorySchema = z.object({
  company_name: z.string().trim().min(2),
  contact_name: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal("").transform(() => null)),
  phone: z.string().trim().optional().nullable(),
});

router.post("/directory", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const parsed = directorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the agent company" });
  await rememberAgent(parsed.data.company_name, parsed.data.contact_name, parsed.data.email, parsed.data.phone);
  const { data } = await supabase.from("operations_agents").select("*").ilike("company_name", parsed.data.company_name).limit(1);
  res.status(201).json(data?.[0] || { ok: true });
});

router.put("/directory/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const parsed = directorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the agent company" });
  const changes = {
    company_name: parsed.data.company_name,
    contact_name: parsed.data.contact_name || null,
    email: parsed.data.email || null,
    phone: parsed.data.phone || null,
  };
  let result = await supabase.from("operations_agents").update(changes).eq("id", req.params.id).select("*").single();
  if (result.error && /phone/i.test(result.error.message || "")) {
    const { phone: _phone, ...withoutPhone } = changes;
    result = await supabase.from("operations_agents").update(withoutPhone).eq("id", req.params.id).select("*").single();
  }
  const { data, error } = result;
  if (error || !data) return res.status(500).json({ error: error?.message || "Could not update the agent" });
  res.json(data);
});

router.delete("/directory/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const { error } = await supabase.from("operations_agents").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/enquiries/:id/updates", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const parsed = z.object({ body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Write an update first" });
  const { data: enquiry } = await supabase.from("enquiries").select("id").eq("id", req.params.id).maybeSingle();
  if (!enquiry) return res.status(404).json({ error: "Enquiry not found" });
  const { data, error } = await supabase
    .from("enquiry_updates")
    .insert({ enquiry_id: enquiry.id, user_id: access.userId, body: parsed.data.body })
    .select("*")
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message || "Could not post the update" });
  res.status(201).json(data);
});

router.post("/enquiries/:id/close", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const parsed = z.object({
    outcome: z.enum(["Closed", "Lost", "No response", "Follow-up closed"]).optional(),
    remark: z.string().trim().optional().nullable(),
  }).safeParse(req.body || {});
  const outcome = parsed.success ? parsed.data.outcome || "Closed" : "Closed";
  const remark = parsed.success ? parsed.data.remark || null : null;
  const stage = outcome === "Lost" ? "lost_closed" : "won_closed";
  const { data, error } = await supabase
    .from("enquiries")
    .update({
      stage: outcome === "Lost" || outcome === "No response" ? "lost_closed" : stage,
      outcome: [outcome, remark].filter(Boolean).join(" — "),
      updated_by: access.userId,
    })
    .eq("id", req.params.id)
    .select("id, enquiry_number, stage, outcome")
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message || "Could not close the inquiry" });
  res.json(data);
});

router.delete("/enquiries/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  try {
    await deleteOperationsEnquiryById(req.params.id);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Could not delete the inquiry" });
  }
  res.json({ ok: true });
});

router.delete("/pipeline", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  if (!access.superAdmin) return res.status(403).json({ error: "Only a super admin can clear the operations pipeline" });
  const ids = await operationsEnquiryIds();
  let deleted = 0;
  for (const id of ids) {
    try {
      await deleteOperationsEnquiryById(id);
      deleted += 1;
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : "Could not clear the pipeline" });
    }
  }
  res.json({ ok: true, deleted });
});

const customerSchema = z.object({
  company_name: z.string().trim().min(2),
  contact_name: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal("").transform(() => null)),
  phone: z.string().trim().optional().nullable(),
});

router.post("/customers", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the customer company" });
  await rememberCustomer(parsed.data.company_name, parsed.data.contact_name, parsed.data.email, parsed.data.phone);
  const { data } = await supabase.from("operations_customers").select("*").ilike("company_name", parsed.data.company_name).limit(1);
  res.status(201).json(data?.[0] || { ok: true });
});

router.put("/customers/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the customer company" });
  const { data, error } = await supabase
    .from("operations_customers")
    .update({
      company_name: parsed.data.company_name,
      contact_name: parsed.data.contact_name || null,
      email: parsed.data.email || null,
      phone: parsed.data.phone || null,
    })
    .eq("id", req.params.id)
    .select("*")
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message || "Could not update the customer" });
  res.json(data);
});

router.delete("/customers/:id", async (req, res) => {
  const access = await requireOperations(req, res);
  if (!access) return;
  const { error } = await supabase.from("operations_customers").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export function registerOperationsRoutes(api: express.Router) {
  api.use("/operations", router);
}
