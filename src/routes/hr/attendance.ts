import express from "express";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../../middleware/auth.js";
import { requireManager } from "../../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

router.use(authMiddleware);

function isManagerRole(role?: string) {
  return role === "manager" || role === "super_admin" || role === "admin";
}

function sessionHours(clockIn: string, clockOut: string | null): number {
  if (!clockOut) return 0;
  return (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3600000;
}

router.get("/", async (req, res) => {
  const userId = req.user?.id;
  const role = req.user?.role;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const targetUserId = (req.query.user_id as string) || userId;
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);

  if (targetUserId !== userId && !isManagerRole(role)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [year, mon] = month.split("-").map(Number);
  const start = new Date(year, mon - 1, 1).toISOString();
  const end = new Date(year, mon, 0, 23, 59, 59).toISOString();

  const { data, error } = await supabase
    .from("clock_sessions")
    .select("*")
    .eq("user_id", targetUserId)
    .gte("clock_in", start)
    .lte("clock_in", end)
    .order("clock_in", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const totalHours = (data || []).reduce(
    (sum, s) => sum + sessionHours(s.clock_in, s.clock_out),
    0,
  );

  res.json({ sessions: data || [], totalHours: Math.round(totalHours * 100) / 100, month });
});

router.get("/summary", requireManager, async (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const start = new Date(year, mon - 1, 1).toISOString();
  const end = new Date(year, mon, 0, 23, 59, 59).toISOString();

  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select("id, full_name, email, department, employee_id")
    .eq("is_active", true)
    .order("full_name");

  if (usersErr) return res.status(500).json({ error: usersErr.message });

  const { data: sessions, error: sessErr } = await supabase
    .from("clock_sessions")
    .select("user_id, clock_in, clock_out")
    .gte("clock_in", start)
    .lte("clock_in", end);

  if (sessErr) return res.status(500).json({ error: sessErr.message });

  const hoursByUser: Record<string, number> = {};
  const daysByUser: Record<string, Set<string>> = {};

  for (const s of sessions || []) {
    const h = sessionHours(s.clock_in, s.clock_out);
    hoursByUser[s.user_id] = (hoursByUser[s.user_id] || 0) + h;
    if (!daysByUser[s.user_id]) daysByUser[s.user_id] = new Set();
    daysByUser[s.user_id].add(s.clock_in.slice(0, 10));
  }

  const summary = (users || []).map((u) => ({
    user_id: u.id,
    full_name: u.full_name,
    email: u.email,
    department: u.department,
    employee_id: u.employee_id,
    total_hours: Math.round((hoursByUser[u.id] || 0) * 100) / 100,
    days_present: daysByUser[u.id]?.size || 0,
  }));

  res.json({ month, data: summary });
});

export function registerHrAttendanceRoutes(parent: express.Router) {
  parent.use("/attendance", router);
}
