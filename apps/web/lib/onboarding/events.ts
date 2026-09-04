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

export const PHASE_LABELS: Record<OnboardingPhase, { active: string; rest: string }> = {
  scanning: { active: "Reading your site", rest: "Read your site" },
  keywords: { active: "Finding what to write about", rest: "Found what to write about" },
  planning: { active: "Scheduling your first month", rest: "Scheduled your first month" },
  drafting: { active: "Writing your first draft", rest: "Wrote your first draft" },
};

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
