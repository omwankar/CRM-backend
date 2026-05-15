import type { SupabaseClient } from "@supabase/supabase-js";

const ALPHANUMERIC = /^[A-Za-z0-9]+$/;

export function isValidEmployeeId(id: string): boolean {
  return ALPHANUMERIC.test(id) && id.length >= 2 && id.length <= 32;
}

/** Next ID like EMP0001, EMP0002, … */
export async function generateNextEmployeeId(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from("users")
    .select("employee_id")
    .not("employee_id", "is", null)
    .like("employee_id", "EMP%");

  let maxNum = 0;
  for (const row of data || []) {
    const eid = row.employee_id as string;
    const num = parseInt(eid.replace(/^EMP/i, ""), 10);
    if (!Number.isNaN(num) && num > maxNum) maxNum = num;
  }

  const next = maxNum + 1;
  return `EMP${String(next).padStart(4, "0")}`;
}

export async function resolveEmailByLogin(
  supabase: SupabaseClient,
  login: string,
): Promise<{ email: string; is_active: boolean } | null> {
  const trimmed = login.trim();
  if (!trimmed) return null;

  if (trimmed.includes("@")) {
    const { data } = await supabase
      .from("users")
      .select("email, is_active")
      .eq("email", trimmed.toLowerCase())
      .maybeSingle();
    return data?.email ? { email: data.email, is_active: data.is_active ?? true } : null;
  }

  const { data } = await supabase
    .from("users")
    .select("email, is_active")
    .eq("employee_id", trimmed)
    .maybeSingle();

  return data?.email ? { email: data.email, is_active: data.is_active ?? true } : null;
}
