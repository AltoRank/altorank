// ---------------------------------------------------------------------------
// When the schedulers actually run
// ---------------------------------------------------------------------------
//
// The planner tells people when their articles are written and published.
// Those times are decided by cron expressions in vercel.json, so they are read
// from that file at build time rather than typed again here: a schedule
// changed in one place and quoted from another is how a UI comes to promise
// 09:00 while the job fires at 07:00.
//
// Vercel crons are UTC. On Hobby they run once a day with roughly hour-level
// precision, which is why the copy says "around".

import vercel from "../../vercel.json";

type CronEntry = { path: string; schedule: string };

/**
 * "HH:MM" for a cron expression that names one minute and one hour; null for
 * anything else (lists, ranges, steps), which this UI has no sentence for.
 */
export function cronUtcTime(expression: string): string | null {
  const [minute, hour] = expression.trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(minute ?? "") || !/^\d{1,2}$/.test(hour ?? "")) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function cronTimeFor(crons: readonly CronEntry[], path: string): string | null {
  const entry = crons.find((c) => c.path === path);
  return entry ? cronUtcTime(entry.schedule) : null;
}

const crons = (vercel as { crons?: CronEntry[] }).crons ?? [];

/** UTC wall-clock times of the two jobs the planner talks about. */
export const SCHEDULE_TIMES = {
  generate: cronTimeFor(crons, "/api/cron/generate"),
  publish: cronTimeFor(crons, "/api/cron/publish"),
};

/**
 * The sentence the planner shows. Falls back to the plain fact when a cron
 * has no single time (or is missing), rather than inventing one.
 */
export function scheduleSentence(times: { generate: string | null; publish: string | null } = SCHEDULE_TIMES): string {
  const written = times.generate ? `around ${times.generate} UTC` : "each morning UTC";
  // Publishing is gated by each site's own publish time and checked every
  // hour (Vercel once a day plus the GitHub Actions workflow), so the honest
  // promise is "within the hour after your publish time", not one UTC clock.
  return `Articles are generated ${written} and land in Review; approved articles publish on your chosen days within the hour after your publish time.`;
}
