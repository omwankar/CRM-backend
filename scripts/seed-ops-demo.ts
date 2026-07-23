/**
 * Seed Clarusto Operations modules with demo data.
 *
 * Covers: Companies (ops), Vendors, Partners, Projects, Jobs/Shipments,
 *         job↔vendor/partner links, ops Tasks, Activities, status milestones.
 *
 * Usage (from backend/):
 *   npx tsx scripts/seed-ops-demo.ts
 *   npx tsx scripts/seed-ops-demo.ts --clear
 *
 * Idempotent: clears prior [SEED-OPS] rows, then inserts a fresh demo set.
 */
import "./../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";

const CLEAR_ONLY = process.argv.includes("--clear");
const MARKER = "[SEED-OPS]";

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

async function clearSeed() {
  console.log("Clearing previous Operations seed…");

  await sb.from("tasks").delete().ilike("notes", `%${MARKER}%`);
  await sb.from("activities").delete().ilike("subject", `%${MARKER}%`);
  await sb.from("activities").delete().ilike("notes", `%${MARKER}%`);

  // Jobs tagged in notes/title
  const { data: jobs } = await sb
    .from("jobs")
    .select("id")
    .or(`notes.ilike.%${MARKER}%,title.ilike.%${MARKER}%`);
  if (jobs?.length) {
    const jids = jobs.map((j) => j.id);
    await sb.from("job_vendors").delete().in("job_id", jids);
    await sb.from("job_partners").delete().in("job_id", jids);
    await sb.from("job_status_history").delete().in("job_id", jids);
    await sb.from("job_attachments").delete().in("job_id", jids);
    await sb.from("jobs").delete().in("id", jids);
  }

  const { data: projects } = await sb
    .from("projects")
    .select("id")
    .or(`requirements_notes.ilike.%${MARKER}%,project_name.ilike.%${MARKER}%`);
  if (projects?.length) {
    const pids = projects.map((p) => p.id);
    await sb.from("project_status_history").delete().in("project_id", pids);
    await sb.from("project_employees").delete().in("project_id", pids);
    await sb.from("projects").delete().in("id", pids);
  }

  const { data: partners } = await sb
    .from("partnerships")
    .select("id")
    .ilike("description", `%${MARKER}%`);
  if (partners?.length) {
    const ids = partners.map((p) => p.id);
    await sb.from("job_partners").delete().in("partnership_id", ids);
    await sb.from("contact_links").delete().eq("entity_type", "partnership").in("entity_id", ids);
    await sb.from("partnerships").update({ deleted_at: new Date().toISOString() }).in("id", ids);
  }

  const { data: vendors } = await sb.from("vendors").select("id").ilike("description", `%${MARKER}%`);
  if (vendors?.length) {
    const vids = vendors.map((v) => v.id);
    await sb.from("job_vendors").delete().in("vendor_id", vids);
    await sb.from("contact_links").delete().eq("entity_type", "vendor").in("entity_id", vids);
    await sb.from("vendors").update({ deleted_at: new Date().toISOString() }).in("id", vids);
  }

  const { data: opps } = await sb.from("opportunities").select("id").ilike("notes", `%${MARKER}%`);
  if (opps?.length) {
    await sb.from("opportunities").delete().in(
      "id",
      opps.map((o) => o.id),
    );
  }

  const { data: buyers } = await sb.from("buyers").select("id").ilike("description", `%${MARKER}%`);
  if (buyers?.length) {
    await sb
      .from("buyers")
      .update({ deleted_at: new Date().toISOString() })
      .in(
        "id",
        buyers.map((b) => b.id),
      );
  }

  const { data: companies } = await sb.from("companies").select("id").ilike("notes", `%${MARKER}%`);
  if (companies?.length) {
    const coids = companies.map((c) => c.id);
    await sb.from("buyers").update({ company_id: null }).in("company_id", coids);
    await sb.from("vendors").update({ company_id: null }).in("company_id", coids);
    await sb.from("partnerships").update({ company_id: null }).in("company_id", coids);
    await sb.from("companies").update({ deleted_at: new Date().toISOString() }).in("id", coids);
  }

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
  const owner3 = users[2]?.id || owner;
  console.log(
    `Using assignees: ${users
      .slice(0, 3)
      .map((u) => u.full_name || u.email)
      .join(", ")}`,
  );

  await clearSeed();
  if (CLEAR_ONLY) {
    console.log("Cleared only. Exiting.");
    return;
  }

  // --- Companies ---
  const companyRows = [
    {
      name: "Mediterranean Line Agents",
      city: "Athens",
      country: "Greece",
      industry: "Shipping Agency",
      website: "https://medline-agents.example",
      company_types: ["partner"],
      notes: `${MARKER} Port agent network`,
    },
    {
      name: "Gulf Gate Customs Brokers",
      city: "Jebel Ali",
      country: "UAE",
      industry: "Customs",
      website: "https://gulfgate.example",
      company_types: ["partner", "vendor"],
      notes: `${MARKER} Customs brokerage`,
    },
    {
      name: "TransArabia Haulage",
      city: "Riyadh",
      country: "Saudi Arabia",
      industry: "Road Freight",
      website: "https://transarabia.example",
      company_types: ["vendor"],
      notes: `${MARKER} Inland trucking`,
    },
    {
      name: "Nordic Reefer Carriers",
      city: "Rotterdam",
      country: "Netherlands",
      industry: "Ocean Carrier",
      company_types: ["vendor", "partner"],
      notes: `${MARKER} Reefer ocean capacity`,
    },
    {
      name: "Oasis Importers KSA",
      city: "Jeddah",
      country: "Saudi Arabia",
      industry: "Trading",
      company_types: ["customer"],
      notes: `${MARKER} Shipper / buyer for ops jobs`,
    },
  ];

  const { data: companies, error: cErr } = await sb
    .from("companies")
    .insert(companyRows.map((c) => ({ ...c, created_by: owner, updated_by: owner })))
    .select("id, name");
  if (cErr || !companies?.length) throw new Error(`companies: ${cErr?.message}`);
  const co = Object.fromEntries(companies.map((c) => [c.name, c.id]));
  console.log(`Companies: ${companies.length}`);

  // --- Buyer (for jobs → opportunity) ---
  const { data: buyers, error: bErr } = await sb
    .from("buyers")
    .insert([
      {
        buyer_name: "Oasis Importers KSA",
        contact_person: "Layla Mansour",
        contact_email: "layla@oasis-importers.example",
        contact_phone: "+966501220001",
        city: "Jeddah",
        country: "Saudi Arabia",
        industry: "Trading",
        company_id: co["Oasis Importers KSA"],
        description: `${MARKER} Ops demo buyer`,
      },
    ])
    .select("id, buyer_name");
  if (bErr || !buyers?.length) throw new Error(`buyers: ${bErr?.message}`);
  const buyerId = buyers[0].id;
  console.log(`Buyers: ${buyers.length}`);

  // --- Vendors ---
  const vendorRows = [
    {
      vendor_name: "TransArabia Haulage",
      vendor_type: "Road",
      contact_person: "Sami Alotaibi",
      contact_email: "sami@transarabia.example",
      contact_phone: "+966501220010",
      city: "Riyadh",
      country: "Saudi Arabia",
      company_id: co["TransArabia Haulage"],
      description: `${MARKER} Inland delivery trucks`,
      payment_terms: "Net 30",
    },
    {
      vendor_name: "Nordic Reefer Carriers",
      vendor_type: "Ocean",
      contact_person: "Eva Bakker",
      contact_email: "eva@nordicreefer.example",
      contact_phone: "+3110220011",
      city: "Rotterdam",
      country: "Netherlands",
      company_id: co["Nordic Reefer Carriers"],
      description: `${MARKER} Reefer vessel slots`,
      payment_terms: "Net 15",
    },
    {
      vendor_name: "Gulf Gate Customs Brokers",
      vendor_type: "Customs",
      contact_person: "Rashid Khan",
      contact_email: "rashid@gulfgate.example",
      contact_phone: "+971501220012",
      city: "Jebel Ali",
      country: "UAE",
      company_id: co["Gulf Gate Customs Brokers"],
      description: `${MARKER} Dual vendor/partner customs`,
    },
  ];

  const { data: vendors, error: vErr } = await sb.from("vendors").insert(vendorRows).select("id, vendor_name");
  if (vErr || !vendors?.length) throw new Error(`vendors: ${vErr?.message}`);
  const vn = Object.fromEntries(vendors.map((v) => [v.vendor_name, v.id]));
  console.log(`Vendors: ${vendors.length}`);

  // --- Partners ---
  const partnerRows = [
    {
      partner_name: "Mediterranean Line Agents",
      partner_company_name: "Mediterranean Line Agents",
      partner_type: "Agent",
      partnership_type: "Agent",
      contact_person: "Nikos Papadopoulos",
      contact_email: "nikos@medline-agents.example",
      contact_phone: "+302101220020",
      start_date: daysFromNow(-400),
      status: "active",
      description: `${MARKER} Piraeus / Eastern Med agency`,
      company_id: co["Mediterranean Line Agents"],
    },
    {
      partner_name: "Gulf Gate Customs Brokers",
      partner_company_name: "Gulf Gate Customs Brokers",
      partner_type: "Customs",
      partnership_type: "Customs",
      contact_person: "Rashid Khan",
      contact_email: "rashid@gulfgate.example",
      contact_phone: "+971501220012",
      start_date: daysFromNow(-200),
      status: "active",
      description: `${MARKER} UAE customs co-loader / broker`,
      company_id: co["Gulf Gate Customs Brokers"],
    },
    {
      partner_name: "Nordic Reefer Carriers",
      partner_company_name: "Nordic Reefer Carriers",
      partner_type: "Logistics",
      partnership_type: "Logistics",
      contact_person: "Eva Bakker",
      contact_email: "eva@nordicreefer.example",
      start_date: daysFromNow(-90),
      status: "active",
      description: `${MARKER} Ocean co-loader for reefer`,
      company_id: co["Nordic Reefer Carriers"],
    },
    {
      partner_name: "Silk Road Air Hub",
      partner_company_name: "Silk Road Air Hub",
      partner_type: "Logistics",
      partnership_type: "Logistics",
      contact_person: "Mei Chen",
      contact_email: "mei@silkroad-air.example",
      start_date: daysFromNow(-30),
      status: "on_hold",
      description: `${MARKER} Air co-loader (on hold)`,
      company_id: null,
    },
  ];

  const { data: partners, error: pErr } = await sb
    .from("partnerships")
    .insert(partnerRows)
    .select("id, partner_name");
  if (pErr || !partners?.length) throw new Error(`partnerships: ${pErr?.message}`);
  const pn = Object.fromEntries(partners.map((p) => [p.partner_name, p.id]));
  console.log(`Partners: ${partners.length}`);

  // --- Won opportunities (Jobs require opportunity_id) ---
  const oppRows = [
    {
      buyer_id: buyerId,
      title: `${MARKER} Jeddah reefer inbound`,
      stage: "closed_won",
      value: 185000,
      currency: "SAR",
      expected_close_date: daysFromNow(-20),
      owner_id: owner,
      notes: `${MARKER} Won — ready for shipment`,
      created_by: owner,
    },
    {
      buyer_id: buyerId,
      title: `${MARKER} Project cargo generators`,
      stage: "closed_won",
      value: 420000,
      currency: "SAR",
      expected_close_date: daysFromNow(-5),
      owner_id: owner2,
      notes: `${MARKER} Won — heavy lift`,
      created_by: owner,
    },
    {
      buyer_id: buyerId,
      title: `${MARKER} Air express spare parts`,
      stage: "closed_won",
      value: 48000,
      currency: "SAR",
      expected_close_date: daysFromNow(-2),
      owner_id: owner,
      notes: `${MARKER} Won — air lane`,
      created_by: owner,
    },
  ];

  const { data: opps, error: oErr } = await sb
    .from("opportunities")
    .insert(oppRows)
    .select("id, title");
  if (oErr || !opps?.length) throw new Error(`opportunities: ${oErr?.message}`);
  const opp = Object.fromEntries(opps.map((o) => [o.title, o.id]));
  console.log(`Opportunities (won): ${opps.length}`);

  // --- Internal Projects ---
  const projectRows = [
    {
      project_name: `${MARKER} Warehouse WMS upgrade`,
      status: "Active",
      start_date: daysFromNow(-45),
      estimated_end_date: daysFromNow(60),
      supervisor_id: owner,
      assigned_person_id: owner2,
      contact_email: "ops@clarusto.example",
      requirements_notes: `${MARKER} Internal initiative — barcode scanners + putaway rules`,
      created_by: owner,
    },
    {
      project_name: `${MARKER} Customs SOP refresh`,
      status: "Planned",
      start_date: daysFromNow(7),
      estimated_end_date: daysFromNow(90),
      supervisor_id: owner,
      assigned_person_id: owner3,
      requirements_notes: `${MARKER} Document new KSA customs process checklist`,
      created_by: owner,
    },
    {
      project_name: `${MARKER} Safety training Q3`,
      status: "On Hold",
      start_date: daysFromNow(-10),
      estimated_end_date: daysFromNow(40),
      supervisor_id: owner2,
      assigned_person_id: owner,
      requirements_notes: `${MARKER} Internal HSE training — paused pending venue`,
      created_by: owner,
    },
  ];

  const { data: projects, error: prErr } = await sb
    .from("projects")
    .insert(projectRows)
    .select("id, project_id, project_name, status");
  if (prErr || !projects?.length) throw new Error(`projects: ${prErr?.message}`);
  console.log(`Projects: ${projects.length}`);

  // Project status history + team
  for (const p of projects) {
    await sb.from("project_status_history").insert({
      project_id: p.id,
      old_status: null,
      new_status: p.status,
      reason: `${MARKER} Project created`,
      changed_by: owner,
    });
    await sb.from("project_employees").insert([
      { project_id: p.id, user_id: owner, role: "admin" },
      { project_id: p.id, user_id: owner2, role: "operations" },
    ]);
  }

  // --- Jobs / Shipments ---
  const jobDefs = [
    {
      title: `${MARKER} Reefer FCL Rotterdam–Jeddah`,
      opportunity_id: opp[`${MARKER} Jeddah reefer inbound`],
      origin: "Rotterdam",
      destination: "Jeddah",
      mode_type: "sea" as const,
      container_type: "40RF",
      weight_kg: 18500,
      volume_cbm: 55,
      cargo_description: "Frozen poultry — 1×40RF, -18°C",
      status: "in_transit",
      vendorNames: ["Nordic Reefer Carriers", "TransArabia Haulage"],
      partnerNames: ["Nordic Reefer Carriers", "Gulf Gate Customs Brokers"],
      milestones: [
        { status: "booked", daysAgo: 18, reason: "Booking confirmed with Nordic" },
        { status: "in_transit", daysAgo: 12, reason: "Vessel sailed Rotterdam" },
      ],
    },
    {
      title: `${MARKER} Generators RORO Antwerp–Dammam`,
      opportunity_id: opp[`${MARKER} Project cargo generators`],
      origin: "Antwerp",
      destination: "Dammam",
      mode_type: "sea" as const,
      container_type: "RORO",
      weight_kg: 42000,
      volume_cbm: 120,
      cargo_description: "2× industrial generators on trailers",
      status: "arrived",
      vendorNames: ["TransArabia Haulage"],
      partnerNames: ["Mediterranean Line Agents"],
      milestones: [
        { status: "booked", daysAgo: 25, reason: "RORO booking locked" },
        { status: "in_transit", daysAgo: 14, reason: "Departed Antwerp" },
        { status: "arrived", daysAgo: 1, reason: "Arrived Dammam port" },
      ],
    },
    {
      title: `${MARKER} AOG spares DXB–RUH`,
      opportunity_id: opp[`${MARKER} Air express spare parts`],
      origin: "Dubai DXB",
      destination: "Riyadh RUH",
      mode_type: "air" as const,
      container_type: "ULD",
      weight_kg: 320,
      volume_cbm: 1.4,
      cargo_description: "Aircraft AOG spare parts — priority",
      status: "booked",
      vendorNames: ["Gulf Gate Customs Brokers"],
      partnerNames: ["Gulf Gate Customs Brokers"],
      milestones: [{ status: "booked", daysAgo: 1, reason: "Air waybill reserved" }],
    },
    {
      title: `${MARKER} Road FTL Jebel Ali–Riyadh`,
      opportunity_id: opp[`${MARKER} Jeddah reefer inbound`],
      origin: "Jebel Ali",
      destination: "Riyadh",
      mode_type: "road" as const,
      container_type: "FTL 40ft",
      weight_kg: 12000,
      volume_cbm: 40,
      cargo_description: "General merchandise — dry FTL",
      status: "delivered",
      vendorNames: ["TransArabia Haulage"],
      partnerNames: ["Gulf Gate Customs Brokers"],
      milestones: [
        { status: "booked", daysAgo: 10, reason: "Truck allocated" },
        { status: "in_transit", daysAgo: 8, reason: "Departed Jebel Ali" },
        { status: "arrived", daysAgo: 6, reason: "At Riyadh DC gate" },
        { status: "delivered", daysAgo: 5, reason: "Unloaded & signed" },
        { status: "pod_received", daysAgo: 4, reason: "POD scanned to file" },
      ],
    },
  ];

  const createdJobs: Array<{ id: string; title: string; status: string }> = [];

  for (const def of jobDefs) {
    const { data: job, error: jErr } = await sb
      .from("jobs")
      .insert({
        title: def.title,
        opportunity_id: def.opportunity_id,
        buyer_id: buyerId,
        origin: def.origin,
        destination: def.destination,
        mode_type: def.mode_type,
        container_type: def.container_type,
        weight_kg: def.weight_kg,
        volume_cbm: def.volume_cbm,
        cargo_description: def.cargo_description,
        status: def.status,
        supervisor_id: owner,
        assigned_person_id: owner2,
        notes: `${MARKER} Demo shipment`,
        created_by: owner,
      })
      .select("id, title, status, job_number")
      .single();

    if (jErr || !job) throw new Error(`job ${def.title}: ${jErr?.message}`);
    createdJobs.push(job);

    for (const m of def.milestones) {
      await sb.from("job_status_history").insert({
        job_id: job.id,
        old_status: null,
        new_status: m.status,
        reason: `${MARKER} ${m.reason}`,
        changed_by: owner,
        changed_at: daysAgo(m.daysAgo),
      });
    }

    for (const name of def.vendorNames) {
      if (vn[name]) {
        await sb.from("job_vendors").insert({ job_id: job.id, vendor_id: vn[name] });
      }
    }
    for (const name of def.partnerNames) {
      if (pn[name]) {
        await sb.from("job_partners").insert({ job_id: job.id, partnership_id: pn[name] });
      }
    }
  }
  console.log(`Jobs: ${createdJobs.length}`);

  // --- Ops Tasks ---
  const taskRows = [
    {
      task_title: "Confirm reefer set-point with Nordic",
      entity_type: "job",
      entity_id: createdJobs[0].id,
      status: "in_progress",
      priority: "high",
      due_date: daysFromNow(1),
      assigned_person_id: owner2,
    },
    {
      task_title: "Arrange Dammam heavy-lift discharge",
      entity_type: "job",
      entity_id: createdJobs[1].id,
      status: "pending",
      priority: "high",
      due_date: daysFromNow(2),
      assigned_person_id: owner,
    },
    {
      task_title: "Collect AOG AWB docs",
      entity_type: "job",
      entity_id: createdJobs[2].id,
      status: "pending",
      priority: "medium",
      due_date: daysFromNow(0),
      assigned_person_id: owner3,
    },
    {
      task_title: "File POD for Jebel Ali–Riyadh FTL",
      entity_type: "job",
      entity_id: createdJobs[3].id,
      status: "completed",
      priority: "low",
      due_date: daysFromNow(-3),
      assigned_person_id: owner2,
      completed_at: daysAgo(3),
    },
    {
      task_title: "Order WMS handheld scanners",
      entity_type: "project",
      entity_id: projects[0].id,
      project_id: projects[0].id,
      status: "in_progress",
      priority: "medium",
      due_date: daysFromNow(10),
      assigned_person_id: owner2,
    },
    {
      task_title: "Draft customs SOP v2 outline",
      entity_type: "project",
      entity_id: projects[1].id,
      project_id: projects[1].id,
      status: "pending",
      priority: "medium",
      due_date: daysFromNow(14),
      assigned_person_id: owner3,
    },
    {
      task_title: "Chase TransArabia rate sheet",
      entity_type: "vendor",
      entity_id: vn["TransArabia Haulage"],
      status: "pending",
      priority: "low",
      due_date: daysFromNow(5),
      assigned_person_id: owner,
    },
  ].map((t) => ({
    ...t,
    task_type: "admin",
    notes: `${MARKER} Ops demo task`,
    created_by: owner,
    supervisor_id: owner,
    assigned_date: daysFromNow(0),
  }));

  const { error: tErr } = await sb.from("tasks").insert(taskRows);
  if (tErr) throw new Error(`tasks: ${tErr.message}`);
  console.log(`Tasks: ${taskRows.length}`);

  // --- Activities ---
  const activityRows = [
    {
      type: "call",
      entity_type: "partnership",
      entity_id: pn["Mediterranean Line Agents"],
      subject: `${MARKER} Intro call with Med Line Agents`,
      notes: "Confirmed agency coverage for Eastern Med ports",
      outcome: "connected",
      activity_date: daysAgo(20),
    },
    {
      type: "email",
      entity_type: "partnership",
      entity_id: pn["Gulf Gate Customs Brokers"],
      subject: `${MARKER} Customs docs checklist shared`,
      notes: "Sent updated HS code list for reefer cargo",
      outcome: "completed",
      activity_date: daysAgo(8),
    },
    {
      type: "meeting",
      entity_type: "vendor",
      entity_id: vn["TransArabia Haulage"],
      subject: `${MARKER} Weekly haulage capacity review`,
      notes: "Agreed surge trucks for Ramadan peak",
      outcome: "completed",
      activity_date: daysAgo(3),
    },
    {
      type: "note",
      entity_type: "vendor",
      entity_id: vn["Nordic Reefer Carriers"],
      subject: `${MARKER} Reefer plug availability note`,
      notes: "Vessel has 12 plugs free week 30",
      outcome: null,
      activity_date: daysAgo(2),
    },
    {
      type: "call",
      entity_type: "partnership",
      entity_id: pn["Nordic Reefer Carriers"],
      subject: `${MARKER} Co-loader slot confirmation`,
      notes: "Locked 1×40RF on sailing NRT-482",
      outcome: "connected",
      activity_date: daysAgo(12),
    },
  ].map((a) => ({ ...a, created_by: owner }));

  const { error: aErr } = await sb.from("activities").insert(activityRows);
  if (aErr) throw new Error(`activities: ${aErr.message}`);
  console.log(`Activities: ${activityRows.length}`);

  console.log("\nOperations seed complete.");
  console.log("  Markers: notes/titles contain [SEED-OPS]");
  console.log("  Clear with: npx tsx scripts/seed-ops-demo.ts --clear");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
