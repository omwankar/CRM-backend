import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../../middleware/auth.js";
import { auditLog } from "../../middleware/auditLog.js";
import { requireHrAccess } from "../../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

router.use(authMiddleware);
router.use(requireHrAccess);
router.use(auditLog);

const schema = z.object({
  employee_id: z.string().uuid(),
  title: z.string().min(1),
  message: z.string().optional(),
  appreciation_date: z.string().optional(),
  category: z.enum(["teamwork", "performance", "milestone", "other"]).default("other"),
});

const updateSchema = schema.partial().omit({ employee_id: true });

async function notifyAppreciation(employeeId: string, title: string, givenByName: string) {
  await supabase.from("notifications").insert({
    user_id: employeeId,
    type: "appreciation",
    title: "You received appreciation",
    message: `${givenByName}: ${title}`,
  });
}

router.get("/", async (req, res) => {
  const { employee_id, page = "1", limit = "20" } = req.query;

  let query = supabase
    .from("hr_appreciations")
    .select("*", { count: "exact" })
    .is("deleted_at", null)
    .order("appreciation_date", { ascending: false });

  if (employee_id) query = query.eq("employee_id", employee_id as string);

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const userIds = Array.from(
    new Set((data || []).flatMap((a) => [a.employee_id, a.given_by]).filter(Boolean)),
  ) as string[];

  let usersMap: Record<string, { full_name?: string; email?: string }> = {};
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", userIds);
    usersMap = (users || []).reduce(
      (acc: Record<string, { full_name?: string; email?: string }>, u: { id: string; full_name?: string; email?: string }) => {
        acc[u.id] = u;
        return acc;
      },
      {},
    );
  }

  const enriched = (data || []).map((a) => ({
    ...a,
    employee_name:
      usersMap[a.employee_id]?.full_name || usersMap[a.employee_id]?.email || "Employee",
    given_by_name: usersMap[a.given_by]?.full_name || usersMap[a.given_by]?.email || "Manager",
  }));

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
    .from("hr_appreciations")
    .select("*")
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

router.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("hr_appreciations")
    .insert({
      ...parsed.data,
      given_by: userId,
      appreciation_date: parsed.data.appreciation_date || new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const giverName = req.user?.full_name || req.user?.email || "A colleague";
  await notifyAppreciation(parsed.data.employee_id, parsed.data.title, giverName);

  res.status(201).json(data);
});

router.put("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("hr_appreciations")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

router.delete("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("hr_appreciations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

export function registerHrAppreciationRoutes(parent: express.Router) {
  parent.use("/appreciations", router);
}
