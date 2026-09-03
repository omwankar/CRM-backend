import { createClient } from '@supabase/supabase-js';
import { normalizeAppRole } from './roles.js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function notifySuperAdmins(
  type: string,
  title: string,
  message: string,
  exceptUserId?: string,
) {
  const { data: users } = await supabase.from('users').select('id, role').eq('is_active', true);
  const admins = (users || []).filter((u: { id: string; role?: string }) => {
    if (exceptUserId && u.id === exceptUserId) return false;
    return normalizeAppRole(u.role) === 'super_admin';
  });
  if (!admins.length) return;
  const { error } = await supabase.from('notifications').insert(
    admins.map((a: { id: string }) => ({
      user_id: a.id,
      type,
      title,
      message,
    })),
  );
  if (error) console.error('[notifySuperAdmins]', error.message);
}
