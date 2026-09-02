import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/operators";
import { inCustomerPreview } from "@/lib/auth/preview";

export { ADMIN_EMAILS, isAdminEmail } from "@/lib/auth/operators";

/**
 * The signed-in user, if they are an operator; null otherwise.
 *
 * Judged on the session the browser actually holds. While an operator is
 * viewing as a customer (lib/auth/impersonation.ts) that session is the
 * customer's, so this is null and the operator pages 404 until they come back.
 * That is the point, not a limitation: the customer view is exactly the
 * customer's, and nobody can chain one impersonation into another.
 *
 * The customer preview (lib/auth/preview.ts) is null here for the same reason,
 * on the same principle. Hiding the Operations entry from the nav while the
 * page behind it still answered would have made the preview a lie in exactly
 * the place someone would check it: a customer typing /admin gets a 404, so a
 * preview that renders the page is not showing what a customer sees.
 */
export async function getOperator(): Promise<User | null> {
  if (await inCustomerPreview()) return null;
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
