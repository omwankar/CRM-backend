import { createClient } from '@supabase/supabase-js';
import type { RequestHandler } from 'express';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export const auditLog: RequestHandler = async (req, _res, next) => {
  // Only log write operations
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  // Capture original res.json to log after response
  const originalJson = _res.json.bind(_res);

  _res.json = (body: unknown) => {
    // Fire-and-forget audit log insert
    insertAuditLog(req).catch(() => {
      // Don't block response if audit log fails
    });
    return originalJson(body);
  };

  next();
};

async function insertAuditLog(req: import('express').Request) {
  const userId = req.user?.id;
  if (!userId) return;

  // Extract table name from path: /api/vendors/:id → vendors
  const pathParts = req.path.split('/').filter(Boolean);
  const tableName = pathParts[0] || 'unknown';

  // Extract record id from path
  const recordId = pathParts[1] || null;

  const action = `${req.method.toLowerCase()}_${tableName}`;

  const changes = req.method === 'DELETE'
    ? { deleted: true }
    : req.body
      ? sanitizeBody(req.body)
      : null;

  await supabase.from('activity_logs').insert({
    user_id: userId,
    action,
    table_name: tableName,
    record_id: recordId,
    changes,
    ip_address: req.ip || req.socket?.remoteAddress || null,
  });
}

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const sensitive = ['password', 'token', 'secret', 'key', 'authorization'];
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (sensitive.some((s) => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
