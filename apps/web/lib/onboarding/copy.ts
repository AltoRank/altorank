// ---------------------------------------------------------------------------
// Sentences the wizard has to keep true
// ---------------------------------------------------------------------------
//
// Pure, and here rather than inside wizard.tsx, because a claim derived from
// the account's state is exactly the kind of thing that should be asserted in
// a test rather than read off a screenshot.

/**
 * The clause that reconciles the thirty-day plan with the free allowance.
 *
 * `buildPlan` fills a 30-day horizon at the site's pace, and FREE_TIER_PACE is
 * 7, so the wizard's "up to one article a day for the next 30 days" is
 * literally true and materially misleading: the monthly entitlement is
 * FREE_DRAFTS, so 23 of those 30 squares render grey with `frozenReason` the
 * first time the person opens the calendar. Nothing in the wizard said so
 * (P1-A1).
 *
 * Returns null when there is nothing to qualify - an unmetered account
 * (self-host, operator, an active plan), for which the plan and the
 * entitlement do not disagree.
 */
export function freeAllowanceClause(freeDrafts: number | null): string | null {
  if (freeDrafts === null || freeDrafts <= 0) return null;
  return `The first ${freeDrafts === 1 ? "one is" : `${freeDrafts} are`} free to read; the 7-day trial writes the rest.`;
}
