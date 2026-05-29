import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

function isManagerRole(role?: string) {
  return role === "manager" || role === "super_admin" || role === "admin";
}

const schema = z.object({
  log_date: z.string(),
  duration_minutes: z.number().int().min(1),
  description: z.string().min(1),
  started_at: z.string().optional().nullable(),
  ended_at: z.string().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  task_id: z.string().uuid().optional().nullable(),
  quotation_id: z.string().uuid().optional().nullable(),
});

const updateSchema = schema.partial();

// GET /api/timelogs?month=YYYY-MM&user_id=
router.get("/", async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const monthStart = `${year}-${String(mon).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, mon, 0).toISOString().slice(0, 10);

  const requestedUser = req.query.user_id as string | undefined;
  // Employees can only read their own logs; managers may read anyone's.
  const targetUser = isManagerRole(role) && requestedUser ? requestedUser : userId;

  const { data, error } = await supabase
    .from("time_logs")
    .select("*")
    .eq("user_id", targetUser)
    .gte("log_date", monthStart)
    .lte("log_date", monthEnd)
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// POST /api/timelogs
router.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("time_logs")
    .insert({
      user_id: userId,
      log_date: parsed.data.log_date,
      duration_minutes: parsed.data.duration_minutes,
      description: parsed.data.description,
      started_at: parsed.data.started_at || null,
      ended_at: parsed.data.ended_at || null,
      project_id: parsed.data.project_id || null,
      task_id: parsed.data.task_id || null,
      quotation_id: parsed.data.quotation_id || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

async function loadOwnedLog(id: string, userId: string, role?: string) {
  const { data } = await supabase.from("time_logs").select("id, user_id").eq("id", id).maybeSingle();
  if (!data) return { ok: false as const, status: 404, error: "Not found" };
  if (data.user_id !== userId && !isManagerRole(role)) {
    return { ok: false as const, status: 403, error: "You can only edit your own time logs" };
  }
  return { ok: true as const };
}

// PUT /api/timelogs/:id
router.put("/:id", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const owned = await loadOwnedLog(req.params.id, userId, req.user?.role);
  if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("time_logs")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

// DELETE /api/timelogs/:id
router.delete("/:id", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const owned = await loadOwnedLog(req.params.id, userId, req.user?.role);
  if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

  const { error } = await supabase.from("time_logs").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerTimeLogRoutes(api: express.Router) {
  api.use("/timelogs", router);
}
