import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../../middleware/auth.js";
import { auditLog } from "../../middleware/auditLog.js";
import { sharedWriteGuard } from "../../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const hrFields = z.object({
  employee_id: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  joining_date: z.string().optional().nullable(),
  employment_status: z.enum(["active", "on_leave", "terminated"]).optional(),
  reporting_manager_id: z.string().uuid().optional().nullable(),
  phone: z.string().optional().nullable(),
  full_name: z.string().optional(),
});

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

const employeeSelect =
  "id, email, full_name, phone, role, department, employee_id, designation, joining_date, employment_status, reporting_manager_id, is_active, avatar_url, last_login, created_at";

router.get("/", async (req, res) => {
  const { search, department, designation, employment_status, page = "1", limit = "50" } =
    req.query;

  let query = supabase
    .from("users")
    .select(employeeSelect, { count: "exact" })
    .eq("is_active", true);

  if (department) query = query.eq("department", department as string);
  if (designation) query = query.ilike("designation", `%${designation}%`);
  if (employment_status) query = query.eq("employment_status", employment_status as string);
  if (search) {
    const s = String(search);
    query = query.or(
      `full_name.ilike.%${s}%,email.ilike.%${s}%,employee_id.ilike.%${s}%,department.ilike.%${s}%`,
    );
  }

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  query = query
    .range((p - 1) * l, p * l - 1)
    .order("full_name", { ascending: true });

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const managerIds = Array.from(
    new Set((data || []).map((u: { reporting_manager_id?: string }) => u.reporting_manager_id).filter(Boolean)),
  ) as string[];

  let managersById: Record<string, { full_name?: string; email?: string }> = {};
  if (managerIds.length) {
    const { data: mgrs } = await supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", managerIds);
    managersById = (mgrs || []).reduce(
      (acc: Record<string, { full_name?: string; email?: string }>, m: { id: string; full_name?: string; email?: string }) => {
        acc[m.id] = m;
        return acc;
      },
      {},
    );
  }

  const enriched = (data || []).map((u: Record<string, unknown> & { reporting_manager_id?: string }) => {
    const mgr = u.reporting_manager_id ? managersById[u.reporting_manager_id] : null;
    return {
      ...u,
      reporting_manager_name: mgr?.full_name || mgr?.email || null,
    };
  });

  res.json({
    data: enriched,
    total: count,
    page: p,
    limit: l,
    totalPages: Math.ceil((count || 0) / l),
  });
});

router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select(employeeSelect)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: "Employee not found" });

  let reporting_manager = null;
  if (data.reporting_manager_id) {
    const { data: mgr } = await supabase
      .from("users")
      .select("id, full_name, email")
      .eq("id", data.reporting_manager_id)
      .maybeSingle();
    reporting_manager = mgr;
  }

  res.json({ ...data, reporting_manager });
});

router.put("/:id", async (req, res) => {
  const parsed = hrFields.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("users")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select(employeeSelect)
    .single();

  if (error || !data) return res.status(404).json({ error: "Employee not found" });
  res.json(data);
});

export function registerHrEmployeeRoutes(parent: express.Router) {
  parent.use("/employees", router);
}
