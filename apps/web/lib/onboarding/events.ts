// ---------------------------------------------------------------------------
// The shape of onboarding, as it happens
// ---------------------------------------------------------------------------
//
// One vocabulary for the whole feature: the server pipeline emits these events,
// the SSE route forwards them verbatim, and the progress screen folds them into
// the state below. Keeping the reducer here - pure, no React, no server imports
// - is what lets it be tested against an exact event sequence rather than
// against a rendered component.

export type OnboardingPhase = "scanning" | "keywords" | "planning" | "drafting";

/** Where a phase is in its life. `skipped` is a real outcome, not a failure. */
export type PhaseStatus = "pending" | "active" | "done" | "skipped" | "failed";

export const PHASE_ORDER: readonly OnboardingPhase[] = ["scanning", "keywords", "planning", "drafting"];

/**
 * One label per phase per outcome.
 *
 * There used to be two - `active` and `rest` - and `rest` was asserted for
 * `done`, `skipped` and `failed` alike, so a run that planned nothing still
 * printed "Scheduled your first month" directly above "Nothing to schedule
 * until there are keywords". A label must never claim an outcome the run did
 * not reach: `pending` is the infinitive because it has not happened yet,
 * `done` is the only past tense, and `skipped` and `failed` say so while the
 * event's own `detail` carries the reason.
 */
export const PHASE_LABELS: Record<OnboardingPhase, Record<PhaseStatus, string>> = {
  scanning: {
    pending: "Read your site",
    active: "Reading your site",
    done: "Read your site",
    skipped: "Skipped reading your site",
    failed: "Could not read your site",
  },
  keywords: {
    pending: "Find what to write about",
    active: "Finding what to write about",
    done: "Found what to write about",
    skipped: "Nothing to write about yet",
    failed: "Could not find what to write about",
  },
  planning: {
    pending: "Schedule your first month",
    active: "Scheduling your first month",
    done: "Scheduled your first month",
    skipped: "Nothing scheduled yet",
    failed: "Could not schedule your first month",
  },
  drafting: {
    pending: "Write your first draft",
    active: "Writing your first draft",
    done: "Wrote your first draft",
    skipped: "No first draft yet",
    failed: "Could not write your first draft",
  },
};

/** The label for one step, chosen by what actually happened to it. */
export function phaseLabel(step: OnboardingStep): string {
  return PHASE_LABELS[step.phase][step.status];
}

/** A draft, reduced to what the calendar chip and the redirect need. */
export interface OnboardingPlanned {
  term: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface OnboardingArticle {
  id: string;
  title: string;
  keyword: string;
  wordCount: number;
  verdict: "clean" | "review" | "high_risk";
}

/**
 * One line off the wire.
 *
 * `phase` names which step it is about; the special `ready` and `error` phases
 * are terminal and belong to the run, not a step. A phase-scoped event carries
 * the status the step should take, and the payload for the one phase that has
 * one - keywords its count, drafting its article.
 */
export type OnboardingEvent =
  | { phase: OnboardingPhase; status: Exclude<PhaseStatus, "pending">; detail?: string; keywordsFound?: number; planned?: OnboardingPlanned[]; article?: OnboardingArticle }
  | { phase: "ready" }
  | { phase: "error"; detail: string };

export interface OnboardingStep {
  phase: OnboardingPhase;
  status: PhaseStatus;
  detail?: string;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  keywordsFound: number | null;
  planned: OnboardingPlanned[];
  article: OnboardingArticle | null;
  /** True once the run has emitted `ready`: the screen may hand off. */
  ready: boolean;
  error: string | null;
}

export function initialOnboardingState(): OnboardingState {
  return {
    steps: PHASE_ORDER.map((phase) => ({ phase, status: "pending" as PhaseStatus })),
    keywordsFound: null,
    planned: [],
    article: null,
    ready: false,
    error: null,
  };
}

/**
 * Fold one event into the state. Total and order-independent enough to survive
 * the network: a duplicated event is idempotent, and a `done` that arrives
 * without its `active` still marks the step done rather than dropping it.
 */
export function reduceOnboarding(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  if (event.phase === "ready") return { ...state, ready: true };
  if (event.phase === "error") return { ...state, error: event.detail };

  const steps = state.steps.map((s) =>
    s.phase === event.phase ? { ...s, status: event.status, detail: event.detail ?? s.detail } : s,
  );

  return {
    ...state,
    steps,
    keywordsFound: event.keywordsFound ?? state.keywordsFound,
    planned: event.planned ?? state.planned,
    article: event.article ?? state.article,
  };
}

/** Whether the run has stopped, either way. */
export function isTerminal(state: OnboardingState): boolean {
  return state.ready || state.error !== null;
}

/** What a run is worth saying about itself, once it has stopped. */
export type OnboardingTone = "working" | "done" | "partial" | "error";

export interface OnboardingOutcome {
  tone: OnboardingTone;
  /** The sentence for the top of the screen. Never claims more than happened. */
  line: string;
  /** Whether anything the person can open came out of the run. */
  produced: boolean;
}

/** The detail line a phase left behind, if it left one. */
function detailFor(state: OnboardingState, phase: OnboardingPhase): string | null {
  const step = state.steps.find((s) => s.phase === phase);
  return step?.detail?.trim() || null;
}

/**
 * The first reason a run has for not having produced what it set out to.
 *
 * Read in the order the phases run, so the earliest thing that went wrong is
 * the one named: "nothing rankable found for this site yet" explains the empty
 * calendar better than "nothing to schedule until there are keywords" does.
 */
function firstReason(state: OnboardingState): string | null {
  for (const phase of PHASE_ORDER) {
    const step = state.steps.find((s) => s.phase === phase);
    if (!step) continue;
    if (step.status === "skipped" || step.status === "failed") {
      const detail = detailFor(state, phase);
      if (detail) return detail;
    }
  }
  return null;
}

/**
 * A reason as the tail of a sentence: no trailing full stop, and a lower-cased
 * first letter - unless the word is one an error message would have shouted on
 * purpose (`ENOTFOUND`, `DNS`, `API`), which "eNOTFOUND" would mangle.
 */
function asClause(reason: string): string {
  const trimmed = reason.replace(/\s*[.!]+$/, "");
  const shouty = /^[A-Z][A-Z0-9_]/.test(trimmed);
  return shouty ? trimmed : trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * The run's own account of itself.
 *
 * This exists because the screen used to close with "Done. Your first month is
 * on the calendar" on the strength of a single `ready` event, which the
 * pipeline emits unconditionally - after a planning phase that scheduled
 * nothing and a drafting phase that was refused, the sentence was simply
 * false. Every branch below is derived from what the run reported: how many
 * entries reached the calendar, whether a draft exists, and the reason the
 * earliest phase gave for stopping short.
 *
 * `handoff` is true when the screen navigates on its own, which changes the
 * sentence from a report into a hand-off.
 */
export function onboardingOutcome(state: OnboardingState, handoff = false): OnboardingOutcome {
  if (state.error) return { tone: "error", line: state.error, produced: false };
  if (!state.ready) {
    return {
      tone: "working",
      line: "This takes about a minute. Nothing publishes without your approval.",
      produced: false,
    };
  }

  const planned = state.planned.length;
  const draft = state.article !== null;
  const reason = firstReason(state);
  const because = reason ? `: ${asClause(reason)}.` : ".";

  if (planned > 0 && draft) {
    const line = `Done. ${planned} article${planned === 1 ? "" : "s"} on the calendar and your first draft is in review.`;
    return { tone: "done", line: handoff ? `${line} Taking you there.` : line, produced: true };
  }
  if (planned > 0) {
    return {
      tone: "partial",
      line: `${planned} article${planned === 1 ? "" : "s"} on the calendar. No draft yet${because}`,
      produced: true,
    };
  }
  if (draft) {
    return {
      tone: "partial",
      line: `Your first draft is in review. Nothing else could be scheduled yet${because}`,
      produced: true,
    };
  }
  return {
    tone: "partial",
    line: `Set up, but nothing could be scheduled yet${because}`,
    produced: false,
  };
}
