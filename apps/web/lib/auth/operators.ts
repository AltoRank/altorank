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
 * The fallback is a *gate*, and only a gate: it decides who may open
 * /admin/*, and losing it would lock the operator out of their own install on
 * the first deploy that forgot the variable. It is not an address to send
 * things to. Anything that would put mail in a mailbox asks
 * `operatorRecipients()` instead, which is empty unless someone said, in this
 * deployment, who the operators are.
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

/**
 * Who to actually send an operator email to. Empty unless ADMIN_EMAILS is set.
 *
 * Deliberately not `ADMIN_EMAILS`. That constant falls back to the AltoRank
 * address so an install with no variable set still has someone who can open
 * the operator pages — reasonable for a gate, wrong for a recipient: it makes
 * every deployment of this open-source repo, ours included, mail one personal
 * Gmail account whose owner never asked for it. An unset variable means nobody
 * has said where operational mail should go, and the honest answer to that is
 * to send none.
 *
 * Read at call time, not at import: a cron reads env after the module graph is
 * built, and a test needs to vary it.
 */
export function operatorRecipients(): string[] {
  const configured = process.env.ADMIN_EMAILS;
  if (typeof configured !== "string") return [];
  return configured
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
