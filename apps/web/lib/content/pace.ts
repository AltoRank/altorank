// ---------------------------------------------------------------------------
// How many articles a week a site should be writing
// ---------------------------------------------------------------------------
//
// `workspaces.auto_generate_weekly_limit` is the only thing bounding a site's
// output now that the schedule runs four times a day (296ad6a). Three numbers
// matter and they are easy to confuse, so they live here with their reasons:
//
//   FREE_TIER_PACE   1/week. What signup sets. A no-plan account gets one free
//                    draft a calendar month anyway (FREE_DRAFTS), so anything
//                    higher would only make the cron attempt work the quota
//                    gate then refuses.
//   PAID_DEFAULT     7/week. What activating a subscription raises it to. One a
//                    day, which is the sentence the homepage has always used,
//                    and about 30 a month against an included 100.
//   MAX_PACE         25/week. The ceiling migration 041 allows, chosen so a
//                    single site CAN reach the 100 a month Managed sells.
//
// Before this, nothing raised the pace when an account started paying: a
// customer went from the free tier's 1 a week to the same 1 a week, about four
// articles a month against a plan sold as 100, with no control anywhere in the
// product to change it. The pricing page's "at the pace you set per site" was
// describing a setting that did not exist.

export const FREE_TIER_PACE = 1;
export const PAID_DEFAULT_PACE = 7;
export const MAX_PACE = 25;

/**
 * The pace to apply when a subscription becomes active.
 *
 * Only ever raises, and only from a value the product itself chose. A customer
 * who has picked their own number - including 0, which is how you pause a site
 * - has said something, and activating a plan is not a reason to overrule it.
 * Returns null when nothing should change, so the caller can skip the write.
 */
export function paceOnActivation(current: number | null | undefined): number | null {
  if (current === null || current === undefined) return PAID_DEFAULT_PACE;
  if (current > FREE_TIER_PACE) return null;
  if (current <= 0) return null;
  return PAID_DEFAULT_PACE;
}

/** Clamp a requested pace into what the column allows, refusing nonsense. */
export function normalisePace(requested: unknown): number | null {
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n)) return null;
  const whole = Math.round(n);
  if (whole < 0 || whole > MAX_PACE) return null;
  return whole;
}

/**
 * Articles a month a pace works out to, for showing beside the control.
 *
 * A rolling week is not a calendar quarter of a month, so the honest figure is
 * the weekly limit times 52/12, rounded. Quoting `weekly * 4` would understate
 * it by about eight per cent and quoting the plan's number would be a promise
 * rather than an arithmetic consequence.
 */
export function monthlyFromPace(weekly: number): number {
  return Math.round((weekly * 52) / 12);
}
