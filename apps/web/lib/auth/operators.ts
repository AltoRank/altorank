/**
 * Operator accounts, by email.
 *
 * A list rather than a role column because there is exactly one operator and
 * adding a `role` to `agency_members` would imply a permission system this
 * product does not have. When there are three of these, it becomes a column.
 *
 * Env-overridable so a self-hoster is the operator of their own install rather
 * than locked out of it by our address. An empty ADMIN_EMAILS means nobody is
 * an operator, which is a legitimate setting for an install with no operator
 * pages in use; only an unset one falls back to the default.
 *
 * This list lived in lib/auth/admin.ts and, copied by hand, in
 * lib/billing/quota.ts. Two copies agree right up until one is edited. This
 * file has no Next imports so the pure unit tests can load it directly.
 */
export const ADMIN_EMAILS: readonly string[] = (process.env.ADMIN_EMAILS ?? "helloaltorank@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** Whether an address belongs to an operator. Case-insensitive; a missing address never does. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
