import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function notifySuperAdmins(type: string, title: string, message: string) {
  const { data: admins } = await supabase
    .from('users')
    .select('id')
    .eq('role', 'super_admin')
    .eq('is_active', true);
  if (!admins?.length) return;
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
