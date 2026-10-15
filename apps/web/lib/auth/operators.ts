/**
 * Operator accounts, by email.
 *
 * A list rather than a role column because there is exactly one operator and
 * adding a `role` to `account_members` would imply a permission system this
 * product does not have. When there are three of these, it becomes a column.
 *
 * Env-only. Unset or empty, nobody is an operator. This used to fall back
 * to the AltoRank team's address, which made that mailbox an operator (the
 * Operations pages, "View as" any account, unmetered) on every install of
 * this repo that forgot the variable: a default grant of access to someone
 * else's customers, not a harmless placeholder. A deployment that wants an
 * operator names one; the hosted deployment sets the variable like any other.
 *
 * This list lived in lib/auth/admin.ts and, copied by hand, in
 * lib/billing/quota.ts. Two copies agree right up until one is edited. This
 * file has no Next imports so the pure unit tests can load it directly.
 */
export const ADMIN_EMAILS: readonly string[] = (process.env.ADMIN_EMAILS ?? "")
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
 * Same rule as the gate (unset or empty is nobody), but read at call time,
 * not at import: a cron reads env after the module graph is built, and a test
 * needs to vary it.
 */
export function operatorRecipients(): string[] {
  const configured = process.env.ADMIN_EMAILS;
  if (typeof configured !== "string") return [];
  return configured
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether a customer may be told a person will write to them. Only when
 * somebody will actually be told: the operator email and the daily digest
 * both go to `operatorRecipients()` and nowhere else, so with ADMIN_EMAILS
 * unset a "we will write within 24 hours" is a promise nobody hears about
 * (review, 2026-09-29).
 */
export function followUpPromised(): boolean {
  return operatorRecipients().length > 0;
}
