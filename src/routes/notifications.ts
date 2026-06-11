import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);

// GET /api/notifications — current user's notifications (newest first)
router.get('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Math.min(100, Number(req.query.limit) || 30);
  let query = supabase
    .from('notifications')
    .select('id, type, title, message, is_read, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (req.query.unread_only === 'true') query = query.eq('is_read', false);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
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

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', req.params.id)
    .eq('user_id', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

export function registerNotificationRoutes(api: express.Router) {
  api.use('/notifications', router);
}
