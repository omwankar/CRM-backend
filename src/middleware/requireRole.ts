/**
 * Role-based access middleware.
 *
 * Roles (see migration 018_simplify_roles.sql):
 *   - user        read-only everywhere; can write only tasks allocated to them
 *   - manager     full read/write on every module except user management
 *   - super_admin everything + user management
 *
 * All factories below assume `authMiddleware` has already populated
 * `req.user.role`.
 */

import type { RequestHandler } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Role = "super_admin" | "manager" | "user";

let cachedClient: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return cachedClient;
}

/**
 * Factory: require the caller to have one of the supplied roles.
 *
 *   router.use(requireRole('manager', 'super_admin'))
 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, res, next) => {
    const role = req.user?.role as Role | undefined;
    if (!role) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!allowed.includes(role)) {
      res.status(403).json({
        error: "forbidden",
        message: `This action requires one of: ${allowed.join(", ")}`,
      });
      return;
    }
    next();
  };
}

/** Anything that mutates "company-wide" data: manager or super_admin. */
export const requireManager: RequestHandler = requireRole("manager", "super_admin");

/** Only super_admin: user invites, role changes, deactivation. */
export const requireSuperAdmin: RequestHandler = requireRole("super_admin");

/**
 * Composite guard for "shared" modules (projects, customers, vendors, …):
 *
 *   - GET requests pass through unconditionally (every authenticated user
 *     can read).
 *   - Mutating verbs require manager / super_admin.
 *
 *   router.use(authMiddleware);
 *   router.use(sharedWriteGuard);
 */
export const sharedWriteGuard: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  return requireManager(req, res, next);
};

/**
 * Tasks have a per-row exception: a plain `user` may modify a task only if
 * they are the assigned person, the supervisor, or the creator.
 *
 *   router.use(authMiddleware);
 *   router.use(taskWriteGuard);
 */
export const taskWriteGuard: RequestHandler = async (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }

  const role = req.user?.role as Role | undefined;
  const userId = req.user?.id;
  if (!role || !userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (role === "manager" || role === "super_admin") {
    next();
    return;
  }

  // Plain user: extract the task id from the path. Layouts:
  //   POST /                          (create) -> denied
  //   PUT  /:id                       update
  //   DELETE /:id                     delete
  //   POST /:id/status                status change
  //   POST /:id/employees             add member
  //   DELETE /:id/employees/:uid      remove member
  //   POST /:id/attachments           upload
  //   DELETE /:id/attachments/:aid    delete attachment
  //   POST /:id/emails/:eid/read      mark email read
  const match = req.path.match(/^\/([0-9a-fA-F-]{36})/);
  if (!match) {
    res.status(403).json({
      error: "forbidden",
      message: "Only managers can create tasks.",
    });
    return;
  }

  const taskId = match[1];
  const { data } = await db()
    .from("tasks")
    .select("assigned_person_id, supervisor_id, created_by")
    .eq("id", taskId)
    .maybeSingle();

  if (!data) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const allowedIds = new Set(
    [data.assigned_person_id, data.supervisor_id, data.created_by].filter(Boolean),
  );

  if (allowedIds.has(userId)) {
    next();
    return;
  }

  res.status(403).json({
    error: "forbidden",
    message: "You can only modify tasks allocated to you.",
  });
};
