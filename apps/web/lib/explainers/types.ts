// ---------------------------------------------------------------------------
// In-app explainers: "How it works" as data
// ---------------------------------------------------------------------------
//
// Each surface that does something non-obvious gets one of these, rendered by
// components/dashboard/how-it-works.tsx. They are data rather than JSX so a
// test can hold every one of them to the same two rules:
//
//   1. every claim is something the code does today. The files under
//      lib/explainers cite the module they were read from; when the module
//      changes, the sentence has to change with it.
//   2. every explainer ends with what it cannot do yet. A feature that only
//      describes its strengths is marketing, and the person reading this is
//      already a customer.
//
// Numbers stay out of the copy where a constant exists (PLAN_MAX_ENTRIES,
// MAX_ARTICLES_PER_RUN, the cron schedules) unless the constant is quoted,
// so a future change to the constant has one place to look.

export interface ExplainerSection {
  /** Short, a noun phrase: "How keywords are chosen". */
  title: string;
  /** One sentence that would be enough on its own. */
  lead: string;
  /** Three to five, each a complete fact. */
  bullets: string[];
}

export interface Explainer {
  /** Stable key, also the dialog's test id. */
  id: string;
  /** The dialog title: the surface's own name. */
  title: string;
  /** One line under the title. */
  intro: string;
  sections: ExplainerSection[];
  /**
   * Honest gaps, as complete sentences. Rendered last, always, under the
   * heading "What this cannot do yet". Never empty: a surface with no gaps
   * has not been looked at hard enough.
   */
  cannotYet: string[];
  /**
   * Where the button belongs. Documentation for the surfaces this track does
   * not own (planner, integrations, improvements, linking), so the owner of
   * that page knows to mount `<HowItWorks explainer={...} />` in its
   * PageHead `actions` slot.
   */
  mountsAt: string;
}

/** Bounds the test enforces. Exported so the test and the type agree. */
export const MIN_BULLETS = 3;
export const MAX_BULLETS = 5;
export const CANNOT_YET_HEADING = "What this cannot do yet";
