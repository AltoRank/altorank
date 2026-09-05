// ---------------------------------------------------------------------------
// What a planner card is, from what the rows say
// ---------------------------------------------------------------------------
//
// A square on the calendar sits over two rows: the `calendar_entries` row that
// promises a day, and the `articles` row that promise becomes. The card used
// to read only the first, so a draft in review, a live article and a failed
// run all said "Scheduled". This is the one mapping from those two rows to a
// state the card can act on, kept pure so the states and the actions each one
// offers can be tested without a browser.
//
//   planned   →  writing  →  in review  →  approved / scheduled  →  live
//
// Two more kinds of square share the grid and the same machine:
//
//   frozen        a planned keyword beyond what the account's plan allows
//                 (lib/plan/frozen.ts decides which). Greyed, says why, offers
//                 only Remove; it thaws on its own when the allowance grows.
//   improvement   a scheduled rewrite of a page that already ranks
//                 (`refresh_tasks`). It sits on its day like an article and
//                 spends one slot of the same pace, so the trade-off is on the
//                 calendar rather than in a settings tab:
//
//   improvement  →  improving  →  improved (awaiting review)
//
// `unknown` is the honest answer when the entry points at an article the page
// could not load, or one in a status this file does not know. It renders "—",
// never a guess (rule 5).

export type PlannerCardState =
  | "planned"
  | "frozen"
  | "writing"
  | "in_review"
  | "approved"
  | "scheduled"
  | "live"
  | "failed"
  | "improvement"
  | "improving"
  | "improved"
  | "improvement_failed"
  | "unknown";

/** The slice of a calendar entry the mapping reads. */
export type EntryFacts = {
  article_id: string | null;
  /** True for a `calendar_entries` row; false for an entry derived from an article. */
  planned: boolean;
};

/** The slice of the article the mapping reads, or null when there is none to read. */
export type ArticleFacts = {
  status: string;
  published_url?: string | null;
} | null;

/** The slice of a `refresh_tasks` row the mapping reads, for an improvement square. */
export type ImprovementFacts = {
  status: "scheduled" | "running" | "done" | "failed" | "cancelled" | string;
} | null;

export type CardContext = {
  /** True when lib/plan/frozen.ts put this entry beyond the plan's allowance. */
  frozen?: boolean;
  /** Present when the square is a scheduled rewrite rather than a keyword. */
  improvement?: ImprovementFacts;
};

/**
 * Map an entry and its article to a card state.
 *
 * `inFlight` says a draft for this entry's keyword is being written right now
 * but has not yet been linked to the entry: `writeNow` links the article only
 * when generation succeeds, so while the writer works the entry still has no
 * `article_id` and the page finds the draft by keyword instead.
 *
 * An improvement is decided from its task alone. Frozen applies only to a
 * keyword that is still planned: once a draft exists the plan limit has
 * already been paid, and a rewrite spends the pace, not the monthly quota.
 */
export function plannerCardState(
  entry: EntryFacts,
  article: ArticleFacts,
  inFlight = false,
  ctx: CardContext = {},
): PlannerCardState {
  if (ctx.improvement) {
    switch (ctx.improvement.status) {
      case "scheduled":
        return "improvement";
      case "running":
        return "improving";
      case "done":
        return "improved";
      case "failed":
        return "improvement_failed";
      default:
        return "unknown";
    }
  }
  if (!entry.article_id) {
    if (inFlight) return "writing";
    if (!entry.planned) return "unknown";
    return ctx.frozen ? "frozen" : "planned";
  }
  if (!article) return "unknown";
  switch (article.status) {
    case "drafting":
      return "writing";
    case "draft":
    case "review":
      return "in_review";
    case "approved":
      return "approved";
    case "scheduled":
      return "scheduled";
    case "live":
      return "live";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

export type CardActions = {
  writeNow: boolean;
  move: boolean;
  instructions: boolean;
  questions: boolean;
  remove: boolean;
  openDraft: boolean;
  openLive: boolean;
  /** Open the Improvements page (or the rewrite's review, once it exists). */
  openImprovement: boolean;
};

const NONE: CardActions = {
  writeNow: false,
  move: false,
  instructions: false,
  questions: false,
  remove: false,
  openDraft: false,
  openLive: false,
  openImprovement: false,
};

/**
 * What the card offers in each state. A planned keyword can be briefed,
 * questioned, written, moved or removed; once the writer starts, nothing is
 * offered until it is done; once an article exists, the article is the record
 * and the card only opens it. A frozen keyword can only be taken off the
 * plan - writing or moving it would pretend the limit is not there. A
 * scheduled improvement moves and unschedules like a planned keyword, and
 * always opens the Improvements page, where the brief and the review live.
 */
export function cardActions(state: PlannerCardState): CardActions {
  switch (state) {
    case "planned":
      return { ...NONE, writeNow: true, move: true, instructions: true, questions: true, remove: true };
    case "frozen":
      return { ...NONE, remove: true };
    case "improvement":
    case "improvement_failed":
      return { ...NONE, move: true, remove: true, openImprovement: true };
    case "improving":
    case "improved":
      return { ...NONE, openImprovement: true };
    case "in_review":
    case "approved":
    case "scheduled":
    case "failed":
      return { ...NONE, openDraft: true };
    case "live":
      return { ...NONE, openLive: true, openDraft: true };
    case "writing":
    case "unknown":
    default:
      return NONE;
  }
}

/** The pill: a `STATUS_META` key for colour, and the words on it. */
export function cardStatusPill(state: PlannerCardState): { status: string; label: string } {
  switch (state) {
    case "planned":
      return { status: "queue", label: "Planned" };
    case "frozen":
      return { status: "paused", label: "Inactive" };
    case "improvement":
      return { status: "planned", label: "Improvement" };
    case "improving":
      return { status: "run", label: "Rewriting…" };
    case "improved":
      return { status: "review", label: "Rewrite ready" };
    case "improvement_failed":
      return { status: "error", label: "Rewrite failed" };
    case "writing":
      return { status: "drafting", label: "Writing…" };
    case "in_review":
      return { status: "review", label: "In review" };
    case "approved":
      return { status: "scheduled", label: "Approved" };
    case "scheduled":
      return { status: "scheduled", label: "Scheduled" };
    case "live":
      return { status: "live", label: "Live" };
    case "failed":
      return { status: "error", label: "Failed" };
    case "unknown":
    default:
      return { status: "draft", label: "—" };
  }
}

/**
 * Only a planned keyword with no article moves, and an improvement that has
 * not run yet. The reason is returned rather than a bare false so the card
 * can say it on hover.
 */
export function dragBlockReason(state: PlannerCardState): string | null {
  switch (state) {
    case "planned":
    case "improvement":
    case "improvement_failed":
      return null;
    case "frozen":
      return "Inactive under the current plan; it moves again once the allowance grows.";
    case "writing":
      return "Being written now; it can move once the draft lands.";
    case "improving":
      return "Being rewritten now.";
    case "improved":
      return "Already rewritten; review it from Improvements.";
    case "unknown":
      return "This entry cannot be moved.";
    default:
      return "Already written; manage the article from Articles.";
  }
}
