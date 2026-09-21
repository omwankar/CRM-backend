import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep unread + read-within-last-24h; drop older read notifications from the list. */
function stillVisible(n: { is_read?: boolean; read_at?: string | null; created_at?: string }) {
  if (!n.is_read) return true;
  const readAt = n.read_at ? new Date(n.read_at).getTime() : 0;
  if (!readAt) return false;
  return Date.now() - readAt < DAY_MS;
}

async function purgeStaleRead(userId: string) {
  const cutoff = new Date(Date.now() - DAY_MS).toISOString();
  // Soft-hide by deleting rows older than 24h after read (keeps inbox clean)
  await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .eq('is_read', true)
    .lt('read_at', cutoff);
}

// GET /api/notifications — current user's notifications (newest first)
router.get('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // Fire-and-forget cleanup of read notifications older than 24h
  purgeStaleRead(userId).catch(() => {});

  const limit = Math.min(100, Number(req.query.limit) || 30);
  let query = supabase
    .from('notifications')
    .select('id, type, title, message, is_read, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(200, limit * 3)); // fetch extra then filter so limit still applies after purge window

  if (req.query.unread_only === 'true') query = query.eq('is_read', false);

  const { data, error } = await query;
  if (error) {
    // Fallback if read_at column not migrated yet
    const fb = await supabase
      .from('notifications')
      .select('id, type, title, message, is_read, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (fb.error) return res.status(500).json({ error: fb.error.message });
    return res.json({ data: fb.data || [] });
  }

  const visible = (data || []).filter(stillVisible).slice(0, limit);
  res.json({ data: visible });
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count || 0 });
});

// POST /api/notifications/read-all — must be registered before /:id/read
router.post('/read-all', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date().toISOString();
  let { error } = await supabase
    .from('notifications')
    .update({ is_read: true, read_at: now })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error && /read_at/i.test(error.message)) {
    ({ error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false));
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date().toISOString();
  let { error } = await supabase
    .from('notifications')
    .update({ is_read: true, read_at: now })
    .eq('id', req.params.id)
    .eq('user_id', userId);

  if (error && /read_at/i.test(error.message)) {
    ({ error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', userId));
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerNotificationRoutes(api: express.Router) {
  api.use('/notifications', router);
}
