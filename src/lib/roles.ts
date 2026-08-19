export type AppRole = 'super_admin' | 'manager' | 'user';

/**
 * Canonicalise whatever was stored on public.users.role.
 * Live rows sometimes have Super Admin, super-admin, admin, empty, etc.
 */
export function normalizeAppRole(raw: unknown): AppRole {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (
    s === 'super_admin' ||
    s === 'superadmin' ||
    s === 'head' ||
    s === 'owner'
  ) {
    return 'super_admin';
  }
  if (s === 'manager' || s === 'admin') return 'manager';
  return 'user';
}
