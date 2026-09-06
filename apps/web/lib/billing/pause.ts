// ---------------------------------------------------------------------------
// Pause instead of cancel: the date arithmetic
// ---------------------------------------------------------------------------
//
// A pause is a length in months and an end date. Billing and article
// generation stop; articles, keywords and settings are kept. The end date is
// stored on every workspace (`paused_until`) and handed to Stripe as
// `pause_collection.resumes_at`, so both sides agree on the same day.

export const PAUSE_MONTHS = [1, 2, 3] as const;
export type PauseMonths = (typeof PAUSE_MONTHS)[number];

export function isPauseMonths(n: unknown): n is PauseMonths {
  return typeof n === "number" && (PAUSE_MONTHS as readonly number[]).includes(n);
}

/** YYYY-MM-DD in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The day the pause ends: the same day of the month, `months` later, clamped
 * to the last day when that month is shorter (Jan 31 + 1 month is Feb 28/29,
 * not Mar 3). Computed in UTC so a pause set in Rome and read in New York
 * names one date.
 */
export function pausedUntil(from: Date, months: PauseMonths): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return isoDate(target);
}

/** Unix seconds for Stripe's `resumes_at`, at the start of that UTC day. */
export function resumesAtUnix(pausedUntilDate: string): number {
  return Math.floor(new Date(`${pausedUntilDate}T00:00:00Z`).getTime() / 1000);
}

/** True once the pause date is today or earlier. */
export function pauseIsOver(pausedUntilDate: string, now: Date): boolean {
  return pausedUntilDate <= isoDate(now);
}

export const PAUSE_COPY = "Billing and article generation pause. Your articles, keywords and settings are kept.";

export function formatPauseDate(pausedUntilDate: string): string {
  return new Date(`${pausedUntilDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
