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

export function isAuthorizedCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return cronSecretFrom(request) === expected;
}
