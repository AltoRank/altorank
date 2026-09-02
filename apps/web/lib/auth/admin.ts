import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/operators";

export { ADMIN_EMAILS, isAdminEmail } from "@/lib/auth/operators";

/**
 * The signed-in user, if they are an operator; null otherwise.
 *
 * Judged on the session the browser actually holds. While an operator is
 * viewing as a customer (lib/auth/impersonation.ts) that session is the
 * customer's, so this is null and the operator pages 404 until they come back.
 * That is the point, not a limitation: the customer view is exactly the
 * customer's, and nobody can chain one impersonation into another.
 */
export async function getOperator(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user && isAdminEmail(user.email) ? user : null;
}

/** Whether the signed-in user may see cross-account operational data. */
export async function isAdmin(): Promise<boolean> {
  return (await getOperator()) !== null;
}
