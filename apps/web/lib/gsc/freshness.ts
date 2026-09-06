// ---------------------------------------------------------------------------
// When the Search Console data was last written, and when it will be next
// ---------------------------------------------------------------------------
//
// "Synced 3 hours ago; next sync 04:00 UTC" is two facts: the newest row's
// timestamp, and the cron schedule. The schedule is read from vercel.json
// rather than typed here, so the line cannot say 04:00 after someone moves
// the cron to 05:00. "Never" is a real value: a connected property with no
// rows yet is exactly what a new account sees.

import vercel from "@/vercel.json";

const ANALYTICS_CRON_PATH = "/api/cron/analytics";

/** The cron expression that runs the analytics sync, or null if none is configured. */
export function analyticsCronSchedule(): string | null {
  const crons = (vercel as { crons?: Array<{ path: string; schedule: string }> }).crons ?? [];
  return crons.find((c) => c.path === ANALYTICS_CRON_PATH)?.schedule ?? null;
}

/**
 * The next run of a daily cron, in UTC. Only the "M H * * *" shape is
 * understood, because that is the only shape the schedule file uses; anything
 * else returns null rather than a guess.
 */
export function nextCronRun(schedule: string | null, now: Date): Date | null {
  if (!schedule) return null;
  const m = schedule.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** "04:00 UTC" */
export function utcClock(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/** The sync's wall-clock time as prose, e.g. "04:00 UTC", or null when unscheduled. */
export function nextSyncClock(now: Date = new Date()): string | null {
  const next = nextCronRun(analyticsCronSchedule(), now);
  return next ? utcClock(next) : null;
}

/**
 * "never", "just now", "42 minutes ago", "3 hours ago", "2 days ago".
 * Coarse on purpose: this line answers "is this stale?", not "when exactly".
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const s = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (s < 60) return "just now";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
