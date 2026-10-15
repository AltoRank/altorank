/**
 * The address a signup's code was sent to, carried from /signup to
 * /signup/verify in an httpOnly cookie scoped to /signup rather than in the
 * URL, so it never lands in history, logs or a Referer. Thirty minutes: long
 * enough to find the email, short enough not to linger on a shared machine.
 */
export const PENDING_SIGNUP_COOKIE = "signup_pending";
export const PENDING_SIGNUP_MAX_AGE = 30 * 60;

/** A code as Supabase issues it: digits only, six by default (configurable up to ten). */
export function normalizeCode(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 10 ? digits : null;
}
