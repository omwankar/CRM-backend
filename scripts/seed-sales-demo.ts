/**
 * Seed Clarusto Sales modules with demo data.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-sales-demo.ts
 *   npx tsx scripts/seed-sales-demo.ts --clear   # remove previous [SEED-SALES] rows only
 *
 * Idempotent: clears prior [SEED-SALES] rows, then inserts a full demo funnel.
 */
import "./../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const CLEAR_ONLY = process.argv.includes("--clear");
const MARKER = "[SEED-SALES]";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

async function clearSeed(userIds: string[]) {
  console.log("Clearing previous Sales seed…");

  // Tasks / activities by marker in notes/subject
  await sb.from("tasks").delete().ilike("notes", `%${MARKER}%`);
  await sb.from("activities").delete().ilike("subject", `%${MARKER}%`);
  await sb.from("activities").delete().ilike("notes", `%${MARKER}%`);

  // Quotations / enquiries / opportunities / leads tagged in notes
  const { data: quotes } = await sb
    .from("quotations")
    .select("id")
    .or(`tracker_remarks.ilike.%${MARKER}%,requirement.ilike.%${MARKER}%`);
  if (quotes?.length) {
    await sb.from("quotations").delete().in(
      "id",
      quotes.map((q) => q.id),
    );
  }

  const { data: enqs } = await sb.from("enquiries").select("id").ilike("notes", `%${MARKER}%`);
  if (enqs?.length) {
    // Unlink opps pointing at these enquiries
    await sb
      .from("opportunities")
      .update({ enquiry_id: null })
      .in(
        "enquiry_id",
        enqs.map((e) => e.id),
      );
    await sb.from("enquiries").delete().in(
      "id",
      enqs.map((e) => e.id),
    );
  }

  const { data: opps } = await sb.from("opportunities").select("id").ilike("notes", `%${MARKER}%`);
  if (opps?.length) {
    await sb
      .from("enquiries")
      .update({ opportunity_id: null })
      .in(
        "opportunity_id",
        opps.map((o) => o.id),
      );
    await sb
      .from("quotations")
      .update({ opportunity_id: null })
      .in(
        "opportunity_id",
        opps.map((o) => o.id),
      );
    await sb.from("opportunities").delete().in(
      "id",
      opps.map((o) => o.id),
    );
  }

  const { data: leads } = await sb.from("leads").select("id").ilike("notes", `%${MARKER}%`);
  if (leads?.length) {
    const leadIds = leads.map((l) => l.id);
    await sb.from("contact_links").delete().eq("entity_type", "lead").in("entity_id", leadIds);
    await sb.from("leads").delete().in("id", leadIds);
  }

  const { data: contacts } = await sb.from("contacts").select("id").ilike("notes", `%${MARKER}%`);
  if (contacts?.length) {
    const cids = contacts.map((c) => c.id);
    await sb.from("contact_links").delete().in("contact_id", cids);
    await sb.from("contacts").delete().in("id", cids);
  }

  const { data: buyers } = await sb.from("buyers").select("id").ilike("description", `%${MARKER}%`);
  if (buyers?.length) {
    const bids = buyers.map((b) => b.id);
    await sb.from("contact_links").delete().eq("entity_type", "buyer").in("entity_id", bids);
    // Soft-delete if column exists; hard delete when possible
    await sb.from("buyers").update({ deleted_at: new Date().toISOString() }).in("id", bids);
  }

  const { data: vendors } = await sb.from("vendors").select("id").ilike("description", `%${MARKER}%`);
  if (vendors?.length) {
    const vids = vendors.map((v) => v.id);
    await sb.from("contact_links").delete().eq("entity_type", "vendor").in("entity_id", vids);
    await sb.from("vendors").update({ deleted_at: new Date().toISOString() }).in("id", vids);
  }

  const { data: companies } = await sb.from("companies").select("id").ilike("notes", `%${MARKER}%`);
  if (companies?.length) {
    const coids = companies.map((c) => c.id);
    await sb.from("contact_links").delete().eq("entity_type", "company").in("entity_id", coids);
    await sb.from("buyers").update({ company_id: null }).in("company_id", coids);
    await sb.from("vendors").update({ company_id: null }).in("company_id", coids);
    await sb.from("companies").update({ deleted_at: new Date().toISOString() }).in("id", coids);
  }

  void userIds;
  console.log("Clear done.");
}

async function main() {
  const { data: users, error: uErr } = await sb
    .from("users")
    .select("id, full_name, email, role")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(5);

  if (uErr || !users?.length) {
    console.error("Need at least one active user in public.users:", uErr?.message);
    process.exit(1);
  }

  const owner = users[0].id;
  const owner2 = users[1]?.id || owner;
  console.log(`Using owners: ${users[0].full_name || users[0].email}${users[1] ? `, ${users[1].full_name || users[1].email}` : ""}`);

  await clearSeed(users.map((u) => u.id));
  if (CLEAR_ONLY) {
    console.log("Cleared only. Exiting.");
    return;
  }

  // --- Companies ---
  const companyRows = [
    {
      name: "Red Sea Freight Co",
      city: "Jeddah",
      country: "Saudi Arabia",
      industry: "Logistics",
      website: "https://redseafreight.example",
      company_types: ["customer", "prospect"],
      notes: `${MARKER} Importer needing FCL lanes`,
    },
    {
      name: "Gulf Petrochem Trading",
      city: "Dammam",
      country: "Saudi Arabia",
      industry: "Oil & Gas",
      website: "https://gulfpetro.example",
      company_types: ["customer"],
      notes: `${MARKER} Recurring chemical shipments`,
    },
    {
      name: "Horizon Retail Group",
      city: "Riyadh",
      country: "Saudi Arabia",
      industry: "Retail",
      company_types: ["customer", "partner"],
      notes: `${MARKER} Multi-branch distribution`,
    },
    {
      name: "AsiaLink Forwarders",
      city: "Dubai",
      country: "UAE",
      industry: "Freight",
      company_types: ["vendor", "partner"],
      notes: `${MARKER} Ocean co-loader partner`,
    },
    {
      name: "Desert Cold Chain LLC",
      city: "Abu Dhabi",
      country: "UAE",
      industry: "Cold Chain",
      company_types: ["vendor"],
      notes: `${MARKER} Reefer trucking vendor`,
    },
  ];

  const { data: companies, error: cErr } = await sb
    .from("companies")
    .insert(companyRows.map((c) => ({ ...c, created_by: owner, updated_by: owner })))
    .select("id, name");
  if (cErr || !companies?.length) throw new Error(`companies: ${cErr?.message}`);
  const co = Object.fromEntries(companies.map((c) => [c.name, c.id]));

  // --- Buyers ---
  const buyerRows = [
    {
      buyer_name: "Red Sea Freight Co",
      contact_person: "Fahad Alami",
      contact_email: "fahad@redseafreight.example",
      contact_phone: "+966501110001",
      city: "Jeddah",
      country: "Saudi Arabia",
      industry: "Logistics",
      company_id: co["Red Sea Freight Co"],
      credit_limit: 250000,
      description: `${MARKER} Primary buyer account`,
    },
    {
      buyer_name: "Gulf Petrochem Trading",
      contact_person: "Noura Hassan",
      contact_email: "noura@gulfpetro.example",
      contact_phone: "+966501110002",
      city: "Dammam",
      country: "Saudi Arabia",
      industry: "Oil & Gas",
      company_id: co["Gulf Petrochem Trading"],
      credit_limit: 500000,
      description: `${MARKER} Chemicals buyer`,
    },
    {
      buyer_name: "Horizon Retail Group",
      contact_person: "Omar Saleh",
      contact_email: "omar@horizonretail.example",
      contact_phone: "+966501110003",
      city: "Riyadh",
      country: "Saudi Arabia",
      industry: "Retail",
      company_id: co["Horizon Retail Group"],
      credit_limit: 150000,
      description: `${MARKER} Retail distribution`,
    },
  ];

  const { data: buyers, error: bErr } = await sb
    .from("buyers")
    .insert(buyerRows)
    .select("id, buyer_name");
  if (bErr || !buyers?.length) throw new Error(`buyers: ${bErr?.message}`);
  const by = Object.fromEntries(buyers.map((b) => [b.buyer_name, b.id]));

  // --- Vendors ---
  const vendorRows = [
    {
      vendor_name: "AsiaLink Forwarders",
      vendor_type: "service",
      contact_person: "Priya Nair",
      contact_email: "priya@asialink.example",
      contact_phone: "+971501110004",
      city: "Dubai",
      country: "UAE",
      company_id: co["AsiaLink Forwarders"],
      description: `${MARKER} Ocean partner`,
    },
    {
      vendor_name: "Desert Cold Chain LLC",
      vendor_type: "service",
      contact_person: "Karim Youssef",
      contact_email: "karim@desertcold.example",
      contact_phone: "+971501110005",
      city: "Abu Dhabi",
      country: "UAE",
      company_id: co["Desert Cold Chain LLC"],
      description: `${MARKER} Reefer trucks`,
    },
  ];

  const { data: vendors, error: vErr } = await sb
    .from("vendors")
    .insert(vendorRows)
    .select("id, vendor_name");
  if (vErr || !vendors?.length) throw new Error(`vendors: ${vErr?.message}`);
  const vd = Object.fromEntries(vendors.map((v) => [v.vendor_name, v.id]));

  // --- Leads ---
  const leadRows = [
    {
      lead_name: "Neom Site Logistics RFP",
      company_name: "Neom Industrial",
      contact_person: "Sara Quinn",
      email: "sara@neom-industrial.example",
      phone: "+966501220001",
      source: "website",
      status: "new",
      estimated_value: 450000,
      assigned_to: owner,
    },
    {
      lead_name: "Pharma reefer lane Jeddah–Riyadh",
      company_name: "MediCare KSA",
      contact_person: "Dr. Lina Farouk",
      email: "lina@medicare.example",
      phone: "+966501220002",
      source: "referral",
      status: "contacted",
      estimated_value: 180000,
      assigned_to: owner2,
    },
    {
      lead_name: "E-com parcel hub setup",
      company_name: "Cartly Arabia",
      contact_person: "Yusuf Khan",
      email: "yusuf@cartly.example",
      source: "cold_call",
      status: "qualified",
      estimated_value: 320000,
      assigned_to: owner,
    },
    {
      lead_name: "Project cargo turbines",
      company_name: "WindEast Energy",
      contact_person: "James Cole",
      email: "james@windeast.example",
      source: "event",
      status: "converted",
      estimated_value: 900000,
      assigned_to: owner,
      converted_buyer_id: by["Gulf Petrochem Trading"],
      converted_at: daysAgo(20),
    },
    {
      lead_name: "Budget LCL probe",
      company_name: "SmallBox Trading",
      contact_person: "Hana Ali",
      email: "hana@smallbox.example",
      source: "other",
      status: "lost",
      estimated_value: 25000,
      assigned_to: owner2,
    },
  ].map((l) => ({
    ...l,
    currency: "INR",
    notes: `${MARKER} Demo lead`,
    created_by: owner,
  }));

  const { data: leads, error: lErr } = await sb.from("leads").insert(leadRows).select("id, lead_name, status");
  if (lErr || !leads?.length) throw new Error(`leads: ${lErr?.message}`);
  const leadByName = Object.fromEntries(leads.map((l) => [l.lead_name, l.id]));

  // --- Opportunities ---
  const oppRows = [
    {
      buyer_id: by["Red Sea Freight Co"],
      title: "Jeddah–Shanghai weekly FCL",
      stage: "negotiating",
      value: 275000,
      expected_close_date: daysFromNow(18),
      owner_id: owner,
      lead_id: null,
    },
    {
      buyer_id: by["Gulf Petrochem Trading"],
      title: "ISO tank chemicals Q3",
      stage: "proposal_sent",
      value: 520000,
      expected_close_date: daysFromNow(35),
      owner_id: owner,
      lead_id: leadByName["Project cargo turbines"] || null,
    },
    {
      buyer_id: by["Horizon Retail Group"],
      title: "Riyadh DC inbound consolidation",
      stage: "contacted",
      value: 140000,
      expected_close_date: daysFromNow(45),
      owner_id: owner2,
      lead_id: null,
    },
    {
      buyer_id: by["Red Sea Freight Co"],
      title: "Air freight peak season",
      stage: "closed_won",
      value: 95000,
      expected_close_date: daysFromNow(-10),
      owner_id: owner,
      lead_id: null,
    },
    {
      buyer_id: by["Horizon Retail Group"],
      title: "Cross-dock trial",
      stage: "closed_lost",
      value: 60000,
      expected_close_date: daysFromNow(-5),
      owner_id: owner2,
      lead_id: null,
    },
    {
      buyer_id: by["Gulf Petrochem Trading"],
      title: "New DG lane scoping",
      stage: "lead",
      value: 210000,
      expected_close_date: daysFromNow(60),
      owner_id: owner,
      lead_id: null,
    },
  ].map((o) => ({
    ...o,
    currency: "INR",
    notes: `${MARKER} Demo opportunity`,
    created_by: owner,
    updated_by: owner,
  }));

  const { data: opps, error: oErr } = await sb.from("opportunities").insert(oppRows).select("id, title, stage");
  if (oErr || !opps?.length) throw new Error(`opportunities: ${oErr?.message}`);
  const oppByTitle = Object.fromEntries(opps.map((o) => [o.title, o.id]));

  // --- Enquiries ---
  const enquiryRows = [
    {
      title: "FCL 40HC Shanghai–Jeddah",
      requirement:
        "Weekly 40HC FCL from Shanghai to Jeddah Islamic Port, CY–CY, including destination THC and trucking to warehouse.",
      stage: "quote_sent",
      priority: "high",
      client_budget: 2800,
      deadline: daysFromNow(7),
      buyer_id: by["Red Sea Freight Co"],
      opportunity_id: oppByTitle["Jeddah–Shanghai weekly FCL"],
      client_email: "fahad@redseafreight.example",
      standalone_project_name: "Red Sea FCL lane",
      owner_id: owner,
    },
    {
      title: "ISO tank DG quote",
      requirement:
        "Quote for ISO tank movements of Class 3 chemicals from Jubail to Jebel Ali, including DG documentation support.",
      stage: "preparing",
      priority: "medium",
      client_budget: 4500,
      deadline: daysFromNow(14),
      buyer_id: by["Gulf Petrochem Trading"],
      opportunity_id: oppByTitle["ISO tank chemicals Q3"],
      client_email: "noura@gulfpetro.example",
      standalone_project_name: "Gulf Petrochem ISO tanks",
      owner_id: owner,
    },
    {
      title: "Retail inbound consolidation",
      requirement:
        "Consolidate LCL from Guangzhou and Shenzhen into one FCL for Horizon Retail Riyadh DC, door delivery.",
      stage: "under_review",
      priority: "medium",
      client_budget: 1900,
      deadline: daysFromNow(21),
      buyer_id: by["Horizon Retail Group"],
      opportunity_id: oppByTitle["Riyadh DC inbound consolidation"],
      client_email: "omar@horizonretail.example",
      standalone_project_name: "Horizon DC inbound",
      owner_id: owner2,
    },
    {
      title: "Air peak season block space",
      requirement:
        "Block space quote for 8 tonnes / week air freight DXB–RUH during Ramadan peak, airport-to-airport.",
      stage: "won_closed",
      priority: "high",
      client_budget: 12000,
      deadline: daysFromNow(-12),
      buyer_id: by["Red Sea Freight Co"],
      opportunity_id: oppByTitle["Air freight peak season"],
      client_email: "fahad@redseafreight.example",
      standalone_project_name: "Air peak block",
      owner_id: owner,
      outcome: "Won — contracted 8w block",
    },
  ].map((e) => ({
    ...e,
    client_currency: "INR",
    notes: `${MARKER} Demo enquiry`,
    created_by: owner,
    updated_by: owner,
  }));

  const { data: enquiries, error: eErr } = await sb
    .from("enquiries")
    .insert(enquiryRows)
    .select("id, title, stage, opportunity_id, buyer_id, owner_id, requirement, client_budget, client_currency, deadline, priority, client_email, standalone_project_name");
  if (eErr || !enquiries?.length) throw new Error(`enquiries: ${eErr?.message}`);

  // Link opp.enquiry_id to first matching enquiry
  for (const enq of enquiries) {
    if (enq.opportunity_id) {
      await sb.from("opportunities").update({ enquiry_id: enq.id }).eq("id", enq.opportunity_id);
    }
  }

  // --- Quotations (require enquiry_id) ---
  const quotePayloads = enquiries.map((enq, i) => {
    const statuses = ["waiting_from_companies", "need_revision", "approved", "quote_given"] as const;
    const stages = ["preparing", "quote_sent", "won_closed", "quote_sent"] as const;
    return {
      enquiry_id: enq.id,
      opportunity_id: enq.opportunity_id,
      buyer_id: enq.buyer_id,
      requirement: enq.requirement,
      status: statuses[i % statuses.length],
      enquiry_stage: stages[i % stages.length],
      enquiry_title: enq.title,
      enquiry_lead: enq.owner_id || owner,
      standalone_project_name: enq.standalone_project_name,
      client_budget: enq.client_budget,
      client_currency: enq.client_currency || "INR",
      deadline: enq.deadline,
      priority: enq.priority || "medium",
      client_email: enq.client_email,
      clarusto_final_price: i === 2 ? 11800 : i === 0 ? 2650 : null,
      clarusto_final_currency: "INR",
      revised_price: i === 1 ? 4300 : null,
      revised_currency: "INR",
      quote_sent_at: i === 0 || i === 2 ? daysAgo(3) : null,
      quote_sent_to_email: i === 0 || i === 2 ? enq.client_email : null,
      tracker_remarks: `${MARKER} Demo quotation`,
      created_by: owner,
      updated_by: owner,
    };
  });

  // Second quote on first enquiry (revised scope)
  if (enquiries[0]) {
    quotePayloads.push({
      enquiry_id: enquiries[0].id,
      opportunity_id: enquiries[0].opportunity_id,
      buyer_id: enquiries[0].buyer_id,
      requirement: enquiries[0].requirement + " Revised: add destination warehouse unpack.",
      status: "waiting_from_companies",
      enquiry_stage: "quote_sent",
      enquiry_title: enquiries[0].title + " (rev 2)",
      enquiry_lead: owner,
      standalone_project_name: enquiries[0].standalone_project_name,
      client_budget: enquiries[0].client_budget,
      client_currency: "INR",
      deadline: daysFromNow(10),
      priority: "high",
      client_email: enquiries[0].client_email,
      clarusto_final_price: null,
      clarusto_final_currency: "INR",
      revised_price: null,
      revised_currency: "INR",
      quote_sent_at: null,
      quote_sent_to_email: null,
      tracker_remarks: `${MARKER} Second quotation same enquiry`,
      created_by: owner,
      updated_by: owner,
    });
  }

  const { data: quotations, error: qErr } = await sb
    .from("quotations")
    .insert(quotePayloads)
    .select("id, quotation_number, enquiry_id");
  if (qErr || !quotations?.length) throw new Error(`quotations: ${qErr?.message}`);

  // --- Contacts + links ---
  const contactRows = [
    {
      full_name: "Fahad Alami",
      email: "fahad@redseafreight.example",
      phone: "+966501110001",
      designation: "Procurement Manager",
      company: "Red Sea Freight Co",
      buyer_id: by["Red Sea Freight Co"],
    },
    {
      full_name: "Noura Hassan",
      email: "noura@gulfpetro.example",
      phone: "+966501110002",
      designation: "Logistics Lead",
      company: "Gulf Petrochem Trading",
      buyer_id: by["Gulf Petrochem Trading"],
    },
    {
      full_name: "Priya Nair",
      email: "priya@asialink.example",
      phone: "+971501110004",
      designation: "Account Manager",
      company: "AsiaLink Forwarders",
      vendor_id: vd["AsiaLink Forwarders"],
    },
    {
      full_name: "Sara Quinn",
      email: "sara@neom-industrial.example",
      phone: "+966501220001",
      designation: "Buyer",
      company: "Neom Industrial",
      lead_id: leadByName["Neom Site Logistics RFP"],
    },
  ].map((c) => ({ ...c, notes: `${MARKER} Demo contact`, created_by: owner }));

  const { data: contacts, error: ctErr } = await sb.from("contacts").insert(contactRows).select("id, full_name");
  if (ctErr || !contacts?.length) throw new Error(`contacts: ${ctErr?.message}`);

  const links = [
    { contact_id: contacts[0].id, entity_type: "buyer", entity_id: by["Red Sea Freight Co"], role: "Decision maker" },
    { contact_id: contacts[0].id, entity_type: "company", entity_id: co["Red Sea Freight Co"], role: "Primary" },
    { contact_id: contacts[0].id, entity_type: "opportunity", entity_id: oppByTitle["Jeddah–Shanghai weekly FCL"], role: "Commercial" },
    { contact_id: contacts[1].id, entity_type: "buyer", entity_id: by["Gulf Petrochem Trading"], role: "Ops contact" },
    { contact_id: contacts[2].id, entity_type: "vendor", entity_id: vd["AsiaLink Forwarders"], role: "Partner AM" },
    { contact_id: contacts[3].id, entity_type: "lead", entity_id: leadByName["Neom Site Logistics RFP"], role: "Prospect" },
  ];
  const { error: linkErr } = await sb.from("contact_links").insert(links);
  if (linkErr) console.warn("contact_links warning:", linkErr.message);

  // --- Activities ---
  const activityRows = [
    {
      type: "call",
      entity_type: "lead",
      entity_id: leadByName["Pharma reefer lane Jeddah–Riyadh"],
      subject: `${MARKER} Intro call — MediCare reefer`,
      notes: "Discussed temperature range and weekly volume.",
      outcome: "connected",
      activity_date: daysAgo(2),
    },
    {
      type: "email",
      entity_type: "opportunity",
      entity_id: oppByTitle["Jeddah–Shanghai weekly FCL"],
      subject: `${MARKER} Sent lane options`,
      notes: "Shared 3 carrier options with ETA comparison.",
      outcome: "completed",
      activity_date: daysAgo(1),
    },
    {
      type: "meeting",
      entity_type: "enquiry",
      entity_id: enquiries[1].id,
      subject: `${MARKER} DG docs review`,
      notes: "Walked through MSDS checklist with Noura.",
      outcome: "completed",
      activity_date: daysAgo(4),
    },
    {
      type: "note",
      entity_type: "quotation",
      entity_id: quotations[0].id,
      subject: `${MARKER} Waiting vendor rates`,
      notes: "AsiaLink promised rates by Friday.",
      activity_date: daysAgo(1),
    },
    {
      type: "call",
      entity_type: "buyer",
      entity_id: by["Horizon Retail Group"],
      subject: `${MARKER} Follow-up on consolidation`,
      notes: "No answer — left voicemail.",
      outcome: "voicemail",
      activity_date: daysAgo(12),
    },
    {
      type: "email",
      entity_type: "company",
      entity_id: co["Gulf Petrochem Trading"],
      subject: `${MARKER} Q3 volume forecast request`,
      activity_date: daysAgo(6),
    },
  ].map((a) => ({ ...a, created_by: owner }));

  const { error: aErr } = await sb.from("activities").insert(activityRows);
  if (aErr) throw new Error(`activities: ${aErr.message}`);

  // --- Tasks ---
  const taskRows = [
    {
      task_title: "Chase AsiaLink FCL rates",
      task_type: "sales",
      assigned_person_id: owner,
      due_date: daysFromNow(2),
      priority: "high",
      status: "in_progress",
      entity_type: "enquiry",
      entity_id: enquiries[0].id,
      notes: `${MARKER} Linked to FCL enquiry`,
    },
    {
      task_title: "Prepare DG checklist pack",
      task_type: "sales",
      assigned_person_id: owner2,
      due_date: daysFromNow(5),
      priority: "medium",
      status: "pending",
      entity_type: "opportunity",
      entity_id: oppByTitle["ISO tank chemicals Q3"],
      notes: `${MARKER} Opp task`,
    },
    {
      task_title: "Call MediCare reefer contact",
      task_type: "sales",
      assigned_person_id: owner,
      due_date: daysFromNow(-1),
      priority: "high",
      status: "pending",
      entity_type: "lead",
      entity_id: leadByName["Pharma reefer lane Jeddah–Riyadh"],
      notes: `${MARKER} Overdue demo task`,
    },
    {
      task_title: "Send revised quote PDF",
      task_type: "sales",
      assigned_person_id: owner,
      due_date: daysFromNow(1),
      priority: "medium",
      status: "pending",
      entity_type: "quotation",
      entity_id: quotations[quotations.length - 1].id,
      notes: `${MARKER} Quotation task`,
    },
    {
      task_title: "Weekly pipeline review notes",
      task_type: "admin",
      assigned_person_id: owner,
      due_date: daysFromNow(3),
      priority: "low",
      status: "pending",
      entity_type: null,
      entity_id: null,
      notes: `${MARKER} Standalone sales admin task`,
    },
  ].map((t) => ({
    ...t,
    created_by: owner,
    assigned_date: daysFromNow(0),
  }));

  const { error: tErr } = await sb.from("tasks").insert(taskRows);
  if (tErr) throw new Error(`tasks: ${tErr.message}`);

  console.log("\nSales demo seed complete:");
  console.log(`  Companies:     ${companies.length}`);
  console.log(`  Buyers:        ${buyers.length}`);
  console.log(`  Vendors:       ${vendors.length}`);
  console.log(`  Leads:         ${leads.length}`);
  console.log(`  Opportunities: ${opps.length}`);
  console.log(`  Enquiries:     ${enquiries.length}`);
  console.log(`  Quotations:    ${quotations.length}`);
  console.log(`  Contacts:      ${contacts.length}`);
  console.log(`  Activities:    ${activityRows.length}`);
  console.log(`  Tasks:         ${taskRows.length}`);
  console.log(`\nMarker: ${MARKER}  (re-run clears then re-seeds)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
