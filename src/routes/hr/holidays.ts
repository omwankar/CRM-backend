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

const schema = z.object({
  date: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
});

const updateSchema = schema.partial();

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

router.get("/", async (req, res) => {
  const { year, page = "1", limit = "100" } = req.query;
  let query = supabase
    .from("calendar_events")
    .select("*", { count: "exact" })
    .eq("event_type", "holiday");

  if (year) {
    query = query.gte("date", `${year}-01-01`).lte("date", `${year}-12-31`);
  }

  const p = Math.max(1, Number(page));
  const l = Math.min(200, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order("date", { ascending: true });

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("id", req.params.id)
    .eq("event_type", "holiday")
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

router.post("/", async (req, res) => {
  const userId = req.user?.id;
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      ...parsed.data,
      event_type: "holiday",
      created_by: userId,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .update(parsed.data)
    .eq("id", req.params.id)
    .eq("event_type", "holiday")
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

router.delete("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("calendar_events")
    .delete()
    .eq("id", req.params.id)
    .eq("event_type", "holiday")
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

export function registerHrHolidayRoutes(parent: express.Router) {
  parent.use("/holidays", router);
}
