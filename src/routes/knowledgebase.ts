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

function isManagerRole(role?: string) {
  return role === "manager" || role === "super_admin" || role === "admin";
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

async function uniqueArticleSlug(base: string, ignoreId?: string): Promise<string> {
  const root = slugify(base) || "article";
  let candidate = root;
  let n = 1;
  // Loop until we find a slug not used by another article.
  // Cheap: a handful of iterations at most.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = supabase.from("kb_articles").select("id").eq("slug", candidate);
    if (ignoreId) query = query.neq("id", ignoreId);
    const { data } = await query.maybeSingle();
    if (!data) return candidate;
    n += 1;
    candidate = `${root}-${n}`;
  }
}

const categorySchema = z.object({
  name: z.string().min(1),
  parent_id: z.string().uuid().optional().nullable(),
  sort_order: z.number().int().optional(),
});

const articleSchema = z.object({
  title: z.string().min(1),
  category_id: z.string().uuid().optional().nullable(),
  summary: z.string().optional().nullable(),
  content: z.string().optional(),
  status: z.enum(["draft", "published"]).default("draft"),
  tags: z.array(z.string()).optional(),
});

const articleUpdateSchema = articleSchema.partial();

const attachmentSchema = z.object({
  file_name: z.string().min(1),
  storage_path: z.string().min(1),
  mime_type: z.string().optional().nullable(),
  size_bytes: z.number().int().optional().nullable(),
});

// --------------------------------------------------------------------------
// Categories
// --------------------------------------------------------------------------
router.get("/categories", async (_req, res) => {
  const { data, error } = await supabase
    .from("kb_categories")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

router.post("/categories", async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }
  const { data, error } = await supabase
    .from("kb_categories")
    .insert({
      name: parsed.data.name,
      slug: slugify(parsed.data.name) || `cat-${Date.now()}`,
      parent_id: parsed.data.parent_id || null,
      sort_order: parsed.data.sort_order ?? 0,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete("/categories/:id", async (req, res) => {
  const { error } = await supabase.from("kb_categories").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --------------------------------------------------------------------------
// Articles
// --------------------------------------------------------------------------
// GET /api/knowledge/articles?search=&category_id=&status=
router.get("/articles", async (req, res) => {
  const { search, category_id, status } = req.query;
  const role = req.user?.role;

  let query = supabase
    .from("kb_articles")
    .select("id, category_id, title, slug, summary, status, tags, updated_at, published_at, created_by")
    .is("deleted_at", null);

  // Plain users only see published articles.
  if (!isManagerRole(role)) {
    query = query.eq("status", "published");
  } else if (status) {
    query = query.eq("status", status as string);
  }

  if (category_id) query = query.eq("category_id", category_id as string);
  if (search) {
    const s = String(search).replace(/[,%()]/g, " ").trim();
    if (s) query = query.or(`title.ilike.%${s}%,summary.ilike.%${s}%,content.ilike.%${s}%`);
  }

  query = query.order("updated_at", { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// GET /api/knowledge/articles/:slug
router.get("/articles/:slug", async (req, res) => {
  const role = req.user?.role;
  const { data, error } = await supabase
    .from("kb_articles")
    .select("*")
    .eq("slug", req.params.slug)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  if (data.status !== "published" && !isManagerRole(role)) {
    return res.status(404).json({ error: "Not found" });
  }

  const { data: attachments } = await supabase
    .from("kb_article_attachments")
    .select("*")
    .eq("article_id", data.id)
    .order("created_at", { ascending: true });

  res.json({ ...data, attachments: attachments || [] });
});

router.post("/articles", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const parsed = articleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const slug = await uniqueArticleSlug(parsed.data.title);
  const { data, error } = await supabase
    .from("kb_articles")
    .insert({
      title: parsed.data.title,
      slug,
      category_id: parsed.data.category_id || null,
      summary: parsed.data.summary || null,
      content: parsed.data.content || "",
      status: parsed.data.status,
      tags: parsed.data.tags || [],
      created_by: userId,
      updated_by: userId,
      published_at: parsed.data.status === "published" ? new Date().toISOString() : null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put("/articles/:id", async (req, res) => {
  const userId = req.user?.id;
  const parsed = articleUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data: existing } = await supabase
    .from("kb_articles")
    .select("id, status, published_at")
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: "Not found" });

  const update: Record<string, unknown> = { ...parsed.data, updated_by: userId, updated_at: new Date().toISOString() };
  if (parsed.data.title) {
    update.slug = await uniqueArticleSlug(parsed.data.title, req.params.id);
  }
  if (parsed.data.status === "published" && existing.status !== "published") {
    update.published_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("kb_articles")
    .update(update)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

router.delete("/articles/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("kb_articles")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });
  res.json({ success: true });
});

// --------------------------------------------------------------------------
// Attachments (file metadata; the file itself is uploaded to Supabase storage)
// --------------------------------------------------------------------------
router.post("/articles/:id/attachments", async (req, res) => {
  const parsed = attachmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
  }

  const { data: article } = await supabase
    .from("kb_articles")
    .select("id")
    .eq("id", req.params.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!article) return res.status(404).json({ error: "Article not found" });

  const { data, error } = await supabase
    .from("kb_article_attachments")
    .insert({
      article_id: req.params.id,
      file_name: parsed.data.file_name,
      storage_path: parsed.data.storage_path,
      mime_type: parsed.data.mime_type || null,
      size_bytes: parsed.data.size_bytes ?? null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete("/attachments/:attachmentId", async (req, res) => {
  const { data, error } = await supabase
    .from("kb_article_attachments")
    .delete()
    .eq("id", req.params.attachmentId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });

  // Best-effort: remove the underlying object from the documents storage bucket.
  if (data.storage_path) {
    await supabase.storage.from("documents").remove([data.storage_path]).catch(() => undefined);
  }

  res.json({ success: true });
});

export function registerKnowledgeBaseRoutes(api: express.Router) {
  api.use("/knowledge", router);
}
