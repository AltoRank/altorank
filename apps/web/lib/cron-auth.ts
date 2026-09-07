import { timingSafeEqual } from "node:crypto";

/**
 * The secret a cron request carries, from either header Vercel or a person
 * might use.
 *
 * Vercel's scheduler calls a cron route with `Authorization: Bearer
 * <CRON_SECRET>`. Every route here checked only `x-cron-secret`, so in
 * production every scheduled run was answered 401 and, because 401 is not an
 * error to the scheduler, nobody noticed: no analysis, no drafts, no rank
 * checks ever ran unattended (found 2026-09-02, when the first outside signup
 * had been waiting a day for a draft). Manual calls keep using x-cron-secret.
 */
export function cronSecretFrom(request: Request): string | null {
  const explicit = request.headers.get("x-cron-secret");
  if (explicit) return explicit;
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

/**
 * Compared byte by byte in constant time, and length-checked first so the
 * comparison itself cannot leak the length. `===` on a secret answers faster
 * the sooner it disagrees, which is a character-at-a-time oracle; over a
 * network that is a long shot, but this one string is the entire authorisation
 * for /api/internal/draft, which writes with the service role into any tenant.
 *
 * An unset CRON_SECRET refuses everyone. Fail closed: a deploy that forgot the
 * variable must not become a deploy that accepts every caller.
 */
export function isAuthorizedCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return secretsMatch(cronSecretFrom(request), expected);
}

export function secretsMatch(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
