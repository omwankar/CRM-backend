/**
 * One-time team provisioning:
 * - Keep only allowlisted people (from MS_GRAPH_SYNC_ALLOWLIST names + role map below)
 * - Create missing Supabase auth + public.users rows
 * - Set roles; remove everyone else from auth + public.users
 *
 * Usage:
 *   npx tsx scripts/provision-team-users.ts           # dry-run
 *   npx tsx scripts/provision-team-users.ts --execute # apply changes
 */
import "../src/loadEnvFile.js";
import { createClient } from "@supabase/supabase-js";
import {
  collectUserEmails,
  getGraphAccessToken,
  graphGet,
  normalizeEmail,
  resolveMailboxEmail,
  type GraphListResponse,
  type GraphUser,
} from "../src/services/graphClient.js";
import { generateNextEmployeeId } from "../src/utils/employeeId.js";

const EXECUTE = process.argv.includes("--execute");

type Role = "super_admin" | "manager" | "user";

/** Display-name / email hints → CRM role (order matters for first match). */
const TEAM: Array<{
  role: Role;
  names: string[];
  emails?: string[];
}> = [
  { role: "super_admin", names: ["om wankar", "omwankar", "omwnakr"] },
  { role: "super_admin", names: ["manju"] },
  { role: "manager", names: ["padma"] },
  { role: "user", names: ["jose f", "jose"], emails: [] },
  { role: "user", names: ["r john"] },
  { role: "user", names: ["santosh nair", "santosh"] },
  { role: "user", names: ["shyam"] },
  { role: "user", names: ["vikram"] },
  { role: "user", names: ["palak kushwaha", "palak"] },
  { role: "user", names: ["ansu"], emails: ["ansu@clarusto.co.uk"] },
];

const USER_SELECT =
  "id,displayName,mail,userPrincipalName,otherMails,proxyAddresses,userType";

function normName(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function nameMatches(displayName: string, patterns: string[]): boolean {
  const dn = normName(displayName);
  for (const p of patterns) {
    const n = normName(p);
    if (!n) continue;
    if (dn === n) return true;
    if (dn.startsWith(`${n} `) || dn.endsWith(` ${n}`)) return true;
    if (n.length >= 3 && dn.includes(n)) return true;
    if (n.split(" ").length === 1 && dn.split(/\s+/).includes(n)) return true;
  }
  return false;
}

function graphUserMatchesTeam(
  user: GraphUser,
  entry: (typeof TEAM)[0],
): boolean {
  if (user.userType === "Guest") return false;
  const emails = collectUserEmails(user);
  const mailbox = normalizeEmail(resolveMailboxEmail(user));
  const all = [...new Set([...emails, ...(mailbox ? [mailbox] : [])])];
  if (entry.emails?.some((e) => all.includes(e.toLowerCase()))) return true;
  return nameMatches(user.displayName || "", entry.names);
}

async function fetchAllMembers(token: string): Promise<GraphUser[]> {
  const users: GraphUser[] = [];
  let path: string | null =
    `/users?$select=${USER_SELECT}&$top=100&$filter=accountEnabled eq true and userType eq 'Member'`;
  while (path) {
    const page = await graphGet<GraphListResponse<GraphUser>>(path, token);
    users.push(...page.value);
    path = page["@odata.nextLink"] ?? null;
  }
  return users;
}

function generatePassword(): string {
  const random = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 12);
  return `${random}9!`;
}

interface ResolvedMember {
  role: Role;
  email: string;
  full_name: string;
  graph_id?: string;
  source: "graph" | "db";
  user_id?: string;
}

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const token = await getGraphAccessToken();
  const graphMembers = await fetchAllMembers(token);

  const { data: dbUsers } = await supabase
    .from("users")
    .select("id, email, full_name, role, employee_id, is_active");

  const resolved: ResolvedMember[] = [];
  const usedEmails = new Set<string>();
  const mergedUserIds = new Set<string>();

  for (const entry of TEAM) {
    let hit: GraphUser | undefined = graphMembers.find((u) => graphUserMatchesTeam(u, entry));

    const targetEmailFromGraph = hit
      ? normalizeEmail(resolveMailboxEmail(hit)) || collectUserEmails(hit)[0]
      : entry.emails?.[0]?.toLowerCase();

    // Reuse existing CRM row for same person (e.g. omwnakr → om.wankar@clarusto.co.uk)
    const dbHitByName = (dbUsers || []).find(
      (u) =>
        u.id &&
        !mergedUserIds.has(u.id) &&
        u.full_name &&
        nameMatches(u.full_name, entry.names),
    );

    if (!hit && entry.emails?.length) {
      const db = (dbUsers || []).find((u) => normName(u.email || "") === entry.emails![0].toLowerCase());
      if (db?.email) {
        mergedUserIds.add(db.id);
        resolved.push({
          role: entry.role,
          email: db.email.toLowerCase(),
          full_name: db.full_name || entry.names[0],
          source: "db",
          user_id: db.id,
        });
        usedEmails.add(db.email.toLowerCase());
        continue;
      }
    }

    if (hit) {
      const email = targetEmailFromGraph;
      if (!email) {
        console.warn(`⚠ No email for ${entry.names.join("/")}`);
        continue;
      }
      if (usedEmails.has(email)) {
        console.warn(`⚠ Skipping duplicate ${email}`);
        continue;
      }
      usedEmails.add(email);

      const existingByEmail = (dbUsers || []).find((u) => normalizeEmail(u.email) === email);
      const existingId = existingByEmail?.id || dbHitByName?.id;
      if (existingId) mergedUserIds.add(existingId);

      resolved.push({
        role: entry.role,
        email,
        full_name: hit.displayName || dbHitByName?.full_name || entry.names[0],
        graph_id: hit.id,
        source: "graph",
        user_id: existingId,
      });
      continue;
    }

    if (dbHitByName?.email) {
      const email = targetEmailFromGraph || dbHitByName.email.toLowerCase();
      if (usedEmails.has(email)) continue;
      usedEmails.add(email);
      mergedUserIds.add(dbHitByName.id);
      resolved.push({
        role: entry.role,
        email,
        full_name: dbHitByName.full_name || entry.names[0],
        source: "db",
        user_id: dbHitByName.id,
      });
      continue;
    }

    console.warn(`⚠ No Azure/DB match for: ${entry.names.join(", ")} (${entry.role})`);
  }

  const keepEmails = new Set(resolved.map((r) => r.email));
  const keepIds = new Set(resolved.map((r) => r.user_id).filter(Boolean));
  const toRemove = (dbUsers || []).filter(
    (u) => u.id && !keepIds.has(u.id) && u.email && !keepEmails.has(normalizeEmail(u.email)!),
  );

  console.log(`\n=== Team provisioning ${EXECUTE ? "(EXECUTE)" : "(DRY RUN)"} ===\n`);
  console.log("KEEP & SET ROLES:");
  for (const m of resolved) {
    console.log(`  ${m.role.padEnd(12)} ${m.full_name} <${m.email}> ${m.user_id ? "(exists)" : "(create)"}`);
  }
  console.log(`\nREMOVE ${toRemove.length} user(s):`);
  for (const u of toRemove) {
    console.log(`  - ${u.full_name} <${u.email}> [${u.role}]`);
  }

  if (!EXECUTE) {
    console.log("\nRun with --execute to apply.\n");
    return;
  }

  const credentials: Array<{ email: string; employee_id: string; password: string; role: Role }> = [];

  for (const member of resolved) {
    let userId = member.user_id;

    if (!userId) {
      const password = generatePassword();
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: member.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: member.full_name, role: member.role },
      });

      if (authError?.message?.includes("already been registered")) {
        const { data: list } = await supabase.auth.admin.listUsers();
        const found = list?.users?.find((u) => normalizeEmail(u.email) === member.email);
        userId = found?.id;
      } else if (authError) {
        console.error(`Failed to create auth for ${member.email}:`, authError.message);
        continue;
      } else {
        userId = authData.user?.id;
        const employeeId = await generateNextEmployeeId(supabase);
        credentials.push({ email: member.email, employee_id: employeeId, password, role: member.role });
      }
    }

    if (!userId) {
      console.error(`No user id for ${member.email}`);
      continue;
    }

    let employeeId =
      (dbUsers || []).find((u) => u.id === userId)?.employee_id || (await generateNextEmployeeId(supabase));

    const { error: upsertErr } = await supabase.from("users").upsert(
      {
        id: userId,
        email: member.email,
        full_name: member.full_name,
        role: member.role,
        employee_id: employeeId,
        is_active: true,
        employment_type: "full_time",
        work_mode: "office",
      },
      { onConflict: "id" },
    );

    if (upsertErr) {
      console.error(`Failed to upsert profile ${member.email}:`, upsertErr.message);
      continue;
    }

    await supabase.auth.admin.updateUserById(userId, {
      email: member.email,
      user_metadata: { full_name: member.full_name, role: member.role },
      ban_duration: "none",
    });

    console.log(`✓ ${member.role} ${member.full_name} <${member.email}>`);
  }

  for (const u of toRemove) {
    if (!u.id) continue;
    const { error: delProfile } = await supabase.from("users").delete().eq("id", u.id);
    if (delProfile) {
      console.warn(`  profile delete ${u.email}: ${delProfile.message} — deactivating instead`);
      await supabase.from("users").update({ is_active: false, role: "user" }).eq("id", u.id);
    }
    const { error: delAuth } = await supabase.auth.admin.deleteUser(u.id);
    if (delAuth) {
      console.warn(`  auth delete ${u.email}: ${delAuth.message}`);
      await supabase.auth.admin.updateUserById(u.id, { ban_duration: "876600h" });
    } else {
      console.log(`✗ removed ${u.full_name} <${u.email}>`);
    }
  }

  if (credentials.length) {
    console.log("\n=== NEW ACCOUNT CREDENTIALS (save securely) ===");
    for (const c of credentials) {
      console.log(`${c.role}\t${c.email}\t${c.employee_id}\t${c.password}`);
    }
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
