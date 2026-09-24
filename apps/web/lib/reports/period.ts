// ---------------------------------------------------------------------------
// The dates a client report may cover
// ---------------------------------------------------------------------------
//
// A report's start and end come from two places: the monthly cron, which
// computes last month, and the dashboard's "Generate report" form, whose two
// <input type="date"> fields go to a server action as plain strings. Nothing
// checked them. They are used three ways: as a window for Search Console and
// GA4, as a date range the Search Console block walks one day at a time, and
// inside the PDF's storage path (lib/reports/storage.ts). A year-9999 end
// used to spin that day walk forever; a string with a slash in it would land
// in the path. So they are checked once, at the top of aggregateReportData,
// which every report goes through, and again by the action for a readable
// error before any work.

/**
 * The longest period a report may cover: 16 months of 31 days. Search
 * Console keeps 16 months, so a longer report would be a window mostly made
 * of days nobody can measure any more.
 */
export const MAX_REPORT_DAYS = 16 * 31;

const DAY_MS = 86_400_000;

/** A real calendar date written YYYY-MM-DD, as days since 1970, or null. */
function calendarDay(date: unknown): number | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; a date that does not survive
  // the round trip is not one the calendar has.
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return null;
  return t / DAY_MS;
}

/**
 * Throws, in words a person can act on, unless start and end are real
 * YYYY-MM-DD dates, start is not after end, and the period is no longer than
 * MAX_REPORT_DAYS. Typed as strings, checked as anything: a server action's
 * arguments are whatever the browser sent.
 */
export function assertReportPeriod(startDate: string, endDate: string): void {
  const start = calendarDay(startDate);
  const end = calendarDay(endDate);
  if (start === null) throw new Error(`The report's start date is not a YYYY-MM-DD date: ${JSON.stringify(startDate)}`);
  if (end === null) throw new Error(`The report's end date is not a YYYY-MM-DD date: ${JSON.stringify(endDate)}`);
  if (start > end) throw new Error(`The report starts (${startDate}) after it ends (${endDate}).`);
  const days = end - start + 1;
  if (days > MAX_REPORT_DAYS) {
    throw new Error(`A report covers at most ${MAX_REPORT_DAYS} days (Search Console keeps 16 months); ${startDate} to ${endDate} is ${days}.`);
  }
}
