import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth.js";
import { auditLog } from "../middleware/auditLog.js";
import { sharedWriteGuard } from "../middleware/requireRole.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(sharedWriteGuard);
router.use(auditLog);

const CATEGORIES = ["birthday", "work_anniversary", "holiday", "general", "work_update"] as const;
const ANNOUNCEMENT_TTL_MS = 24 * 60 * 60 * 1000;

const schema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  category: z.enum(CATEGORIES).default("general"),
  audience: z.enum(["all", "role", "users"]).default("all"),
  audience_roles: z.array(z.string()).optional(),
  audience_user_ids: z.array(z.string().uuid()).optional(),
  is_pinned: z.boolean().optional(),
  publish_at: z.string().optional(),
  /** Optional override; defaults to publish_at + 24 hours */
  expires_at: z.string().optional().nullable(),
});

const updateSchema = schema.partial();

function plus24Hours(fromIso: string): string {
  return new Date(new Date(fromIso).getTime() + ANNOUNCEMENT_TTL_MS).toISOString();
}

/** Soft-delete rows past expires_at (and legacy rows with no expiry older than 24h from publish). */
export async function purgeExpiredAnnouncements() {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - ANNOUNCEMENT_TTL_MS).toISOString();

  await supabase
    .from("announcements")
    .update({ deleted_at: nowIso, updated_at: nowIso })
    .is("deleted_at", null)
    .not("expires_at", "is", null)
    .lt("expires_at", nowIso);

  await supabase
    .from("announcements")
    .update({ deleted_at: nowIso, updated_at: nowIso, expires_at: nowIso })
    .is("deleted_at", null)
    .is("expires_at", null)
    .lt("publish_at", cutoff);
}

/** Pick the audience user-ids who should receive a notification. */
async function resolveAudienceUserIds(announcement: {
  audience: string;
  audience_roles?: string[] | null;
  audience_user_ids?: string[] | null;
}): Promise<string[]> {
  if (announcement.audience === "users") {
    return announcement.audience_user_ids || [];
  }
  let query = supabase.from("users").select("id").is("deleted_at", null);
  if (announcement.audience === "role" && announcement.audience_roles?.length) {
    query = query.in("role", announcement.audience_roles);
  }
  const { data } = await query;
  return (data || []).map((u: { id: string }) => u.id);
}

async function notifyAudience(
  announcement: {
    id: string;
    title: string;
    audience: string;
    audience_roles?: string[] | null;
    audience_user_ids?: string[] | null;
  },
  authorName: string,
) {
  const userIds = await resolveAudienceUserIds(announcement);
  if (!userIds.length) return;
  const rows = userIds.map((uid) => ({
    user_id: uid,
    type: "announcement",
    title: "New announcement",
    message: `${authorName}: ${announcement.title}`,
  }));
  await supabase.from("notifications").insert(rows);
}

function isStillActive(row: { publish_at: string; expires_at?: string | null }) {
  const now = Date.now();
  const published = new Date(row.publish_at).getTime();
  if (published > now) return false;
  const expires = row.expires_at
    ? new Date(row.expires_at).getTime()
    : published + ANNOUNCEMENT_TTL_MS;
  return expires > now;
}

// GET /api/announcements
router.get("/", async (req, res) => {
  const { category, page = "1", limit = "50" } = req.query;

  await purgeExpiredAnnouncements();

  let query = supabase
    .from("announcements")
    .select("*", { count: "exact" })
    .is("deleted_at", null);

  if (category) query = query.eq("category", category as string);

  // Hide unpublished and expired (24h TTL; also covers legacy null expires_at)
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - ANNOUNCEMENT_TTL_MS).toISOString();
  query = query
    .lte("publish_at", now)
    .or(
      `and(expires_at.not.is.null,expires_at.gte.${now}),and(expires_at.is.null,publish_at.gte.${cutoff})`,
    );

  const p = Math.max(1, Number(page));
  const l = Math.min(100, Number(limit));
  query = query
    .order("is_pinned", { ascending: false })
    .order("publish_at", { ascending: false })
    .range((p - 1) * l, p * l - 1);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const authorIds = Array.from(
    new Set((data || []).map((a) => a.created_by).filter(Boolean)),
  ) as string[];
  let authors: Record<string, string> = {};
  if (authorIds.length) {
    const { data: users } = await supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", authorIds);
    authors = (users || []).reduce(
      (acc: Record<string, string>, u: { id: string; full_name?: string; email?: string }) => {
        acc[u.id] = u.full_name || u.email || "Team";
        return acc;
      },
      {},
    );
  }

  const rows = (data || [])
    .filter(isStillActive)
    .map((a) => ({
      ...a,
      author_name: a.created_by ? authors[a.created_by] || "Team" : "Team",
    }));
  res.json({ data: rows, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /api/announcements/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data || !isStillActive(data)) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

// POST /api/announcements
router.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const publishAt = parsed.data.publish_at || new Date().toISOString();
  const expiresAt = parsed.data.expires_at || plus24Hours(publishAt);

  const { data, error } = await supabase
    .from("announcements")
    .insert({
      title: parsed.data.title,
      body: parsed.data.body,
      category: parsed.data.category,
      audience: parsed.data.audience,
      audience_roles: parsed.data.audience_roles || [],
      audience_user_ids: parsed.data.audience_user_ids || [],
      is_pinned: parsed.data.is_pinned ?? false,
      publish_at: publishAt,
      expires_at: expiresAt,
      created_by: userId,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await notifyAudience(data, req.user?.full_name || req.user?.email || "A colleague");
  res.status(201).json(data);
});

// PUT /api/announcements/:id
router.put("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data, error } = await supabase
    .from("announcements")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

// DELETE /api/announcements/:id (soft delete)
router.delete("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("announcements")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

export function registerAnnouncementRoutes(api: express.Router) {
  api.use("/announcements", router);
}
