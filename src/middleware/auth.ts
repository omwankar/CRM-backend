import { createClient } from '@supabase/supabase-js';
import type { RequestHandler } from 'express';
import { normalizeAppRole } from '../lib/roles.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

type AuthUser = {
  id: string;
  email: string;
  role: string;
  full_name: string | null;
};

const AUTH_CACHE_TTL_MS = 45_000;
const authCache = new Map<string, { user: AuthUser; expiresAt: number }>();

function cacheGet(token: string): AuthUser | null {
  const hit = authCache.get(token);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    authCache.delete(token);
    return null;
  }
  return hit.user;
}

function cacheSet(token: string, user: AuthUser) {
  if (authCache.size > 500) {
    const first = authCache.keys().next().value;
    if (first) authCache.delete(first);
  }
  authCache.set(token, { user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}

export function invalidateAuthCacheForUser(userId: string) {
  for (const [token, hit] of authCache) {
    if (hit.user.id === userId) authCache.delete(token);
  }
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        full_name: string | null;
      };
    }
  }
}

export const authMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.split(' ')[1];

    const cached = cacheGet(token);
    if (cached) {
      req.user = cached;
      next();
      return;
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Fetch user role from public.users
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('role, full_name, email')
      .eq('id', user.id)
      .maybeSingle();

    if (userError) {
      console.error('Auth middleware: Error fetching user data:', userError.message);
      res.status(500).json({ error: 'Failed to load user profile' });
      return;
    }

    // Fail closed: a valid token without a profile row gets no access
    if (!userData) {
      res.status(403).json({ error: 'User profile not found. Contact an administrator.' });
      return;
    }

    const role = normalizeAppRole(userData.role);

    req.user = {
      id: user.id,
      email: userData.email || user.email || '',
      role,
      full_name: userData.full_name || null,
    };
    cacheSet(token, req.user);

    next();
  } catch {
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// Optional auth — attaches user if token present, but doesn't block
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('role, full_name, email')
          .eq('id', user.id)
          .maybeSingle();

        if (userError) {
          console.error('Optional auth: Error fetching user data:', userError);
        }

        req.user = {
          id: user.id,
          email: userData?.email || user.email || '',
          role: normalizeAppRole(userData?.role),
          full_name: userData?.full_name || null,
        };
      }
    }
  } catch {
    // Ignore errors for optional auth
  }
  next();
};
