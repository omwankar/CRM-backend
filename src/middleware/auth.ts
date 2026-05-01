import { createClient } from '@supabase/supabase-js';
import type { RequestHandler } from 'express';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

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
      console.error('Auth middleware: Error fetching user data:', userError);
    }

    if (!userData) {
      console.error('Auth middleware: User not found in users table:', user.id);
    }

    req.user = {
      id: user.id,
      email: userData?.email || user.email || '',
      role: userData?.role || 'user',
      full_name: userData?.full_name || null,
    };
    
    console.log('Auth middleware: User authenticated:', req.user.email, 'Role:', req.user.role);

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
          role: userData?.role || 'user',
          full_name: userData?.full_name || null,
        };
      }
    }
  } catch {
    // Ignore errors for optional auth
  }
  next();
};
