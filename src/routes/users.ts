import express from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authMiddleware } from '../middleware/auth.js';
import { auditLog } from '../middleware/auditLog.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.use(authMiddleware);
router.use(auditLog);

// Helper: require super_admin
function requireSuperAdmin(req: express.Request, res: express.Response): boolean {
  if (req.user?.role !== 'super_admin') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// Role values that an admin can ASSIGN via the UI. Note `super_admin` is
// intentionally absent - it can only be granted directly in the database.
const assignableRole = z.enum(['manager', 'user']);

const inviteSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2).max(100),
  role: assignableRole,
  department: z.string().optional(),
  phone: z.string().optional(),
});

// "Create user instantly" - super_admin adds a user with a password and the
// account is ready to log in. No email confirmation, no invite link.
const createSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2).max(100),
  role: assignableRole,
  // If omitted, the server generates one and returns it in the response so
  // the super_admin can share the credentials manually.
  password: z.string().min(8).max(128).optional(),
  department: z.string().optional(),
  phone: z.string().optional(),
});

/**
 * Generate a reasonably strong random password: 16 chars from the URL-safe
 * base64 alphabet plus a guaranteed digit and symbol.
 */
function generatePassword(): string {
  // 12 random base64 chars + a digit + a symbol = >= 14 chars, mixed classes.
  const random = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 12);
  const digit = Math.floor(Math.random() * 10).toString();
  const symbols = '!@#$%^&*';
  const symbol = symbols[Math.floor(Math.random() * symbols.length)];
  return `${random}${digit}${symbol}`;
}

const updateSchema = z.object({
  full_name: z.string().optional(),
  phone: z.string().optional(),
  role: assignableRole.optional(),
  department: z.string().optional(),
  is_active: z.boolean().optional(),
});

// GET / — list users (super_admin only for full management)
router.get('/', async (req, res) => {
  const userRole = req.user?.role;
  if (!['super_admin', 'admin', 'manager'].includes(userRole || '')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { search, role, is_active, page = '1', limit = '20' } = req.query;
  let query = supabase.from('users').select('id, email, full_name, role, department, phone, is_active, last_login, invited_by, invited_at, avatar_url, created_at', { count: 'exact' });
  if (role) query = query.eq('role', role);
  if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  const p = Math.max(1, Number(page)), l = Math.min(100, Number(limit));
  query = query.range((p - 1) * l, p * l - 1).order('created_at', { ascending: false });
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: p, limit: l, totalPages: Math.ceil((count || 0) / l) });
});

// GET /me — current user profile
router.get('/me', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found', details: error?.message });
  res.json(data);
});

// GET /debug/me — debug endpoint to check session and user data
router.get('/debug/me', async (req, res) => {
  const userId = req.user?.id;
  const userEmail = req.user?.email;
  const userRole = req.user?.role;

  // Fetch fresh data from DB
  const { data: dbUser, error: dbError } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  res.json({
    fromToken: {
      id: userId,
      email: userEmail,
      role: userRole,
    },
    fromDatabase: dbUser,
    databaseError: dbError,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST / — instantly create a user (super_admin only).
 *
 * Uses Supabase Auth admin API with `email_confirm: true`, so the account
 * is ready to sign in immediately - no confirmation email, no invite link.
 * If no password is supplied, one is generated and returned in the response.
 */
router.post('/', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const { email, full_name, role, department, phone } = parsed.data;
  const password = parsed.data.password || generatePassword();
  const passwordWasGenerated = !parsed.data.password;

  // 1) Create the auth user with email already confirmed.
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, role },
  });

  if (authError) {
    // Common case: user with that email already exists in auth.users.
    return res.status(400).json({ error: authError.message });
  }
  const newUserId = authData.user?.id;
  if (!newUserId) {
    return res.status(500).json({ error: 'Failed to create auth user' });
  }

  // 2) Upsert the public.users profile row. The `handle_new_user` trigger
  // usually creates it with role='user' - we overwrite with the right role
  // and the other fields supplied by the admin.
  const { data: userData, error: insertError } = await supabase
    .from('users')
    .upsert(
      {
        id: newUserId,
        email,
        full_name,
        role,
        department: department || null,
        phone: phone || null,
        is_active: true,
        invited_by: req.user?.id,
        invited_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
    .select()
    .single();

  if (insertError) {
    // Auth user is orphaned at this point - best-effort cleanup.
    await supabase.auth.admin.deleteUser(newUserId).catch(() => {});
    return res.status(500).json({ error: insertError.message });
  }

  // 3) Activity log
  await supabase.from('activity_logs').insert({
    action: 'user_created_direct',
    user_id: req.user?.id,
    record_id: newUserId,
    details: { email, full_name, role },
  });

  // 4) Return credentials so the super_admin can share them with the new user.
  // The generated password is the ONLY time it's ever returned in plaintext.
  res.status(201).json({
    user: userData,
    credentials: {
      email,
      password,
      password_was_generated: passwordWasGenerated,
    },
    message: `User ${email} created. They can sign in now.`,
  });
});

// POST /invite — invite new user (super_admin only)
router.post('/invite', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { email, full_name, role, department, phone } = parsed.data;

  // 1. Invite user via Supabase Auth
  const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { full_name, role },
  });

  if (inviteError) return res.status(400).json({ error: inviteError.message });
  const newUserId = inviteData.user?.id;
  if (!newUserId) return res.status(500).json({ error: 'Failed to create user' });

  // 2. Insert into users table
  const { data: userData, error: insertError } = await supabase.from('users').upsert({
    id: newUserId,
    email,
    full_name,
    role,
    department: department || null,
    phone: phone || null,
    is_active: true,
    invited_by: req.user?.id,
    invited_at: new Date().toISOString(),
  }, { onConflict: 'id' }).select().single();

  if (insertError) return res.status(500).json({ error: insertError.message });

  // 3. Activity log
  await supabase.from('activity_logs').insert({
    action: 'user_invited',
    user_id: req.user?.id,
    record_id: newUserId,
    details: { email, full_name, role },
  });

  res.json({ user: userData, message: `Invitation sent to ${email}` });
});

// GET /:id
router.get('/:id', async (req, res) => {
  const userRole = req.user?.role;
  const userId = req.user?.id;

  if (req.params.id !== userId && !['super_admin', 'admin', 'manager'].includes(userRole || '')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { data, error } = await supabase.from('users').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// PUT /:id — update user (super_admin only for role changes)
router.put('/:id', async (req, res) => {
  const userRole = req.user?.role;
  const userId = req.user?.id;

  // Users can update own profile (except role), super_admin can update all
  if (req.params.id !== userId && userRole !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Non-super_admins cannot change role
  if (req.body.role && userRole !== 'super_admin') {
    delete req.body.role;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });

  const { data, error } = await supabase.from('users').update(parsed.data).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });

  // If role changed, update auth metadata
  if (parsed.data.role) {
    await supabase.auth.admin.updateUserById(req.params.id, {
      user_metadata: { role: parsed.data.role },
    });
  }

  // Activity log
  await supabase.from('activity_logs').insert({
    action: 'user_updated',
    user_id: req.user?.id,
    record_id: req.params.id,
    details: parsed.data,
  });

  res.json(data);
});

// POST /:id/deactivate (super_admin only)
router.post('/:id/deactivate', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const { data, error } = await supabase.from('users').update({ is_active: false }).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });

  // Ban user in auth
  await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: '876600h' });

  await supabase.from('activity_logs').insert({
    action: 'user_deactivated',
    user_id: req.user?.id,
    record_id: req.params.id,
  });

  res.json({ success: true });
});

// POST /:id/reactivate (super_admin only)
router.post('/:id/reactivate', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const { data, error } = await supabase.from('users').update({ is_active: true }).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });

  // Unban user in auth
  await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: 'none' });

  await supabase.from('activity_logs').insert({
    action: 'user_reactivated',
    user_id: req.user?.id,
    record_id: req.params.id,
  });

  res.json({ success: true });
});

// POST /:id/reset-password (super_admin only)
router.post('/:id/reset-password', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const { data: userData } = await supabase.from('users').select('email').eq('id', req.params.id).maybeSingle();
  if (!userData) return res.status(404).json({ error: 'User not found' });

  await supabase.auth.admin.generateLink({ type: 'recovery', email: userData.email });

  res.json({ message: 'Password reset email sent' });
});

export function registerUserRoutes(api: express.Router) {
  api.use('/users', router);
}
