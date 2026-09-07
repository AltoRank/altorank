/**
 * Where a keyword is in its life, and which way it may still move.
 *
 * `keywords.status` is constrained by migration 054 to
 * `new | stored | planned | drafting | scheduled | shipped | error`. Only the
 * first two, plus `error`, are before the plan; the rest are in it or past it,
 * and writing `planned` over them moves the row backwards - which is what
 * `/keywords` did on every press of the "+" beside a drafting keyword.
 */
export const PRE_PLAN_STATUSES = ["new", "stored", "error"] as const;

/** Statuses that mean the plan already owns this keyword. */
export const IN_PLAN_STATUSES = ["planned", "drafting", "scheduled", "shipped"] as const;

export function canAddToPlan(status: string | null | undefined): boolean {
  return PRE_PLAN_STATUSES.includes((status ?? "new") as (typeof PRE_PLAN_STATUSES)[number]);
}

/** What to tell someone whose "+" is disabled, in their own vocabulary. */
export function addToPlanBlockedReason(status: string | null | undefined): string {
  switch (status) {
    case "planned":
      return "Already on the calendar";
    case "drafting":
      return "Its article is being written";
    case "scheduled":
      return "Its article is scheduled to publish";
    case "shipped":
      return "Its article is published";
    default:
      return "Already in the plan";
  }
}
