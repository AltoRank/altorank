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

export function isCadenceDue(
  cadence: Pick<PublishingCadence, "timezone" | "days_of_week" | "publish_time">,
  now: Date = new Date(),
  /**
   * The local date this workspace last published on, from publish_log. Pass
   * null when it has never published. When this equals today's local date the
   * cadence is not due, which is what makes repeat runs in one day safe.
   */
  lastPublishedLocalDate: string | null = null,
): boolean {
  const { timezone, days_of_week, publish_time } = cadence;
  const { day, date, minutes } = localParts(timezone, now);

  if (day < 0 || !days_of_week.includes(day)) return false;
  if (lastPublishedLocalDate === date) return false;

  const [targetHour, targetMinute] = publish_time.split(":").map(Number);
  const targetMins = targetHour * 60 + (targetMinute || 0);

  // At or past the time, with no upper bound. The upper bound was the bug.
  return minutes >= targetMins;
}
