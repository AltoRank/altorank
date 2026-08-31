import { createClient } from "@/lib/supabase/server";

/**
 * Operator accounts, by email.
 *
 * A list rather than a role column because there is exactly one operator and
 * adding a `role` to `agency_members` would imply a permission system this
 * product does not have. When there are three of these, it becomes a column.
 *
 * Env-overridable so a self-hoster is the operator of their own install rather
 * than locked out of it by our address.
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "helloaltorank@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** Whether the signed-in user may see cross-account operational data. */
export async function isAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email?.toLowerCase();
  return Boolean(email && ADMIN_EMAILS.includes(email));
}
