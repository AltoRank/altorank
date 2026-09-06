import type { PublishingCadence } from "@/lib/types";

/**
 * Is a cadence due right now?
 *
 * This used to ask "are we inside a 15-minute window starting at publish_time",
 * which only works if the cron runs at least every 15 minutes. Vercel's Hobby
 * plan runs cron jobs ONCE PER DAY with per-hour (±59 min) precision, so a
 * 15-minute window was missed on almost every run and cadence publishing would
 * simply never fire. Not late: never.
 *
 * The test is now "due and not yet done today" rather than "inside a window":
 *
 *   1. today (in the cadence's timezone) is an enabled day, AND
 *   2. we are at or past publish_time, AND
 *   3. this workspace has not already published on this local date
 *
 * That is correct at ANY cron frequency, from once a minute to once a day, and
 * it is idempotent: running it five times in an afternoon publishes once.
 *
 * The cost is honest and worth stating in the UI: publish_time becomes the
 * EARLIEST time an article may go out, not the exact time. On a daily cron the
 * actual moment is whenever that cron fires. For SEO content the exact minute
 * does not matter; implying precision we do not have would.
 *
 * Timezone handling uses Intl.DateTimeFormat, no external deps.
 */

/** Day-of-week and local date, resolved in the cadence's own timezone. */
function localParts(timezone: string, now: Date): { day: number; date: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  // Hour can come back as "24" at midnight in some ICU versions with hour12:false.
  const hour = Number(get("hour")) % 24;

  return {
    day: dayMap[get("weekday")] ?? -1,
    // en-CA gives ISO-ish parts, so this is the local calendar date.
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/** The cadence's local calendar date, used as the "already published" key. */
export function cadenceLocalDate(timezone: string, now: Date = new Date()): string {
  return localParts(timezone, now).date;
}

export type CadenceDueState =
  | { due: true; reason: null }
  | { due: false; reason: "not a publishing day" | "already published today" | "before publish time" };

/**
 * Why a cadence is or is not due right now. The publish cron records the
 * reason per cadence so an empty run reads as "skipped: before publish time"
 * rather than looking identical to "no cadences at all".
 */
export function cadenceDueState(
  cadence: Pick<PublishingCadence, "timezone" | "days_of_week" | "publish_time">,
  now: Date = new Date(),
  /**
   * The local date this workspace last published on, from publish_log. Pass
   * null when it has never published. When this equals today's local date the
   * cadence is not due, which is what makes repeat runs in one day safe.
   */
  lastPublishedLocalDate: string | null = null,
): CadenceDueState {
  const { timezone, days_of_week, publish_time } = cadence;
  const { day, date, minutes } = localParts(timezone, now);

  if (day < 0 || !days_of_week.includes(day)) return { due: false, reason: "not a publishing day" };
  if (lastPublishedLocalDate === date) return { due: false, reason: "already published today" };

  const [targetHour, targetMinute] = publish_time.split(":").map(Number);
  const targetMins = targetHour * 60 + (targetMinute || 0);

  // At or past the time, with no upper bound. The upper bound was the bug.
  // The lower bound is only meaningful because the cron runs more than once
  // a day (Vercel at 09:00 UTC plus the hourly GitHub Actions workflow); on a
  // single daily run any publish_time after it would never be reached.
  if (minutes < targetMins) return { due: false, reason: "before publish time" };
  return { due: true, reason: null };
}

export function isCadenceDue(
  cadence: Pick<PublishingCadence, "timezone" | "days_of_week" | "publish_time">,
  now: Date = new Date(),
  lastPublishedLocalDate: string | null = null,
): boolean {
  return cadenceDueState(cadence, now, lastPublishedLocalDate).due;
}

/**
 * Drop cadences (or scheduled articles) belonging to paused workspaces.
 *
 * `workspaces.status = 'paused'` is what "Pause this site" sets, and it has to
 * stop publishing as surely as it stops writing. The generate, analyze and
 * site-pages crons filter on the workspace row directly; publishing starts
 * from cadences and articles, which carry only a workspace_id, so the paused
 * set is read once and applied here.
 */
export function withoutPaused<T extends { workspace_id: string }>(
  rows: readonly T[],
  pausedWorkspaceIds: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => !pausedWorkspaceIds.has(r.workspace_id));
}
