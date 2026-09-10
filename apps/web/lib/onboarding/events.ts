// ---------------------------------------------------------------------------
// The shape of onboarding, as it happens
// ---------------------------------------------------------------------------
//
// One vocabulary for the whole feature: the server pipeline emits these events,
// the worker folds each one into an `onboarding_runs` row as it happens, and
// the progress screen polls that row and folds it into the state below. Keeping
// the reducer here - pure, no React, no server imports - is what lets it be
// tested against an exact event sequence rather than against a rendered
// component, and what lets `stateFromRun` be checked against it: a persisted
// run must render exactly as the live stream of its events would have.

export type OnboardingPhase = "scanning" | "keywords" | "pages" | "planning" | "drafting";

/** Where a phase is in its life. `skipped` is a real outcome, not a failure. */
export type PhaseStatus = "pending" | "active" | "done" | "skipped" | "failed";

/**
 * `pages` sits after `keywords` and not next to `scanning`, which is where it
 * reads more naturally, for two reasons that are about the data rather than
 * the sentence. `analyseDomain` writes the ranked keywords that
 * `syncSitePages` attaches to each page, so running after it means a page's
 * keyword comes from the SERP rather than from its slug; and `detectLinks`,
 * which fills the internal-link pool right after this, reads `site_pages` for
 * a target's title, so a crawl that has already happened makes the pool
 * better on the very first draft.
 */
export const PHASE_ORDER: readonly OnboardingPhase[] = ["scanning", "keywords", "pages", "planning", "drafting"];

/**
 * The phases whose failure explains an empty calendar.
 *
 * `onboardingOutcome` names the earliest thing that went wrong as the reason
 * nothing was scheduled, and that is only honest for phases the schedule
 * depends on. Nothing downstream needs `pages`: a site with no sitemap still
 * gets keywords, a plan and a draft, so letting "no sitemap we could read"
 * become the stated reason for a missing plan would blame the wrong thing.
 */
const OUTCOME_PHASES: readonly OnboardingPhase[] = ["scanning", "keywords", "planning", "drafting"];

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
  // "Check" and not "audit": an audit in this product is the DataForSEO crawl
  // on /audits, with a score and a cost, and calling this one an audit too
  // would make two different things share a word on the same account. What
  // this does is read the pages that are already published and report what is
  // mechanically wrong with them.
  pages: {
    pending: "Check your existing pages",
    active: "Checking your existing pages",
    done: "Checked your existing pages",
    skipped: "No existing pages to check",
    failed: "Could not check your existing pages",
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

// ---------------------------------------------------------------------------
// The run as a row
// ---------------------------------------------------------------------------
//
// `onboarding_runs` (migration 076) carries the reducer's own output: `phases`
// is `steps`, `planned` is `planned`, `keywords_found` is `keywordsFound`. The
// article is a foreign key rather than a copy, so the row cannot claim a draft
// that has since been deleted; /state joins the article row back in.

export type OnboardingRunStatus = "running" | "done" | "partial" | "error";

export interface OnboardingRunRow {
  id: string;
  workspace_id: string;
  status: OnboardingRunStatus;
  phases: OnboardingStep[];
  planned: OnboardingPlanned[];
  keywords_found: number | null;
  article_id: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** The columns of the first draft the screen needs, as `articles` stores them. */
export interface OnboardingRunArticle {
  id: string;
  title: string | null;
  keyword: string | null;
  word_count: number | null;
  fact_check_verdict: string | null;
  status: string;
}

/** What GET /api/onboard/state answers, and what the wizard is handed on load. */
export interface OnboardingRunSnapshot {
  run: OnboardingRunRow | null;
  article: OnboardingRunArticle | null;
  /** A `running` row nothing has written to for RUN_STALE_MS: the worker died. */
  stale: boolean;
}

/**
 * How long a `running` row may go without a write before it is presumed dead.
 *
 * The worker writes after every phase and the draft route writes once
 * research is done and again at the end, so the longest honest silence is the
 * model writing the draft - 282s at the worst measured. Ten minutes is the
 * same ceiling first-draft-live gives a `drafting` article before it stops
 * polling; past it the screen reports the run stopped rather than spinning.
 */
export const RUN_STALE_MS = 10 * 60_000;

/**
 * How recently a finished run has to have finished for /onboarding to open on
 * its result instead of on the wizard. A reload seconds after "Done." lands
 * on the plan; a visit next week opens the wizard to edit the setup.
 */
export const RUN_RECENT_MS = 60 * 60_000;

export function isRunStale(run: Pick<OnboardingRunRow, "status" | "updated_at">, now: number): boolean {
  return run.status === "running" && now - new Date(run.updated_at).getTime() > RUN_STALE_MS;
}

/** Whether /onboarding should open on this run rather than on the wizard. */
export function shouldResumeRun(snapshot: OnboardingRunSnapshot | null, now: number): boolean {
  const run = snapshot?.run;
  if (!run) return false;
  if (run.status === "running") return !snapshot.stale;
  return run.finished_at !== null && now - new Date(run.finished_at).getTime() < RUN_RECENT_MS;
}

export const STALE_RUN_ERROR =
  "This run stopped responding. Everything it finished is kept, and tonight's run picks up the rest.";

const VERDICTS: readonly OnboardingArticle["verdict"][] = ["clean", "review", "high_risk"];

/**
 * The persisted row, as the state the screen renders.
 *
 * The inverse of what the worker does with `reduceOnboarding`: it folded
 * events into `steps`/`planned`/`keywordsFound` and wrote them down, and this
 * reads them back. Phases the row has not reached yet are `pending`, in
 * PHASE_ORDER, so a row with an empty `phases` renders as the first frame of a
 * live run did. `ready` is the row having left `running`; the article is
 * whatever `article_id` points at, which is set only once the draft is saved.
 */
export function stateFromRun(
  run: OnboardingRunRow | null,
  article: OnboardingRunArticle | null,
  opts: { stale?: boolean } = {},
): OnboardingState {
  const base = initialOnboardingState();
  if (!run) return base;
  const known = new Map((run.phases ?? []).map((p) => [p.phase, p] as const));
  const steps: OnboardingStep[] = PHASE_ORDER.map((phase) => {
    const p = known.get(phase);
    if (!p) return { phase, status: "pending" };
    return p.detail === undefined ? { phase, status: p.status } : { phase, status: p.status, detail: p.detail };
  });
  const draft: OnboardingArticle | null =
    article && run.article_id === article.id
      ? {
          id: article.id,
          title: article.title ?? "",
          keyword: article.keyword ?? "",
          wordCount: article.word_count ?? 0,
          verdict: VERDICTS.find((v) => v === article.fact_check_verdict) ?? "review",
        }
      : null;
  return {
    steps,
    keywordsFound: run.keywords_found,
    planned: run.planned ?? [],
    article: draft,
    ready: run.status !== "running",
    error: run.error ?? (opts.stale ? STALE_RUN_ERROR : null),
  };
}

/**
 * The status a run settles on, from what it produced. The same rule
 * `onboardingOutcome` reads the "Done." line from, so the row and the sentence
 * cannot disagree: a plan and a draft is `done`; anything less is `partial`,
 * and the phases say which part. `error` is reserved for the worker itself
 * throwing - a phase that failed is `partial`, because the others still ran.
 */
export function runStatusFrom(state: Pick<OnboardingState, "planned" | "article" | "error">): Exclude<OnboardingRunStatus, "running"> {
  if (state.error) return "error";
  return state.planned.length > 0 && state.article !== null ? "done" : "partial";
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
  for (const phase of OUTCOME_PHASES) {
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
/**
 * What the dashboard should say about a run that fell short, or null.
 *
 * A run that ended `partial` with nothing to open, ended `error`, or is
 * `running` but has stopped writing, used to leave the dashboard silent: the
 * run screen said "partial" for twenty-five seconds and the person landed on
 * a dashboard of dashes with no way back and nothing to press. Measured on a
 * real signup, 2026-09-09. This is the same sentence the run screen prints
 * (`onboardingOutcome`), so the banner and the screen cannot disagree, plus
 * the run id the banner uses to remember a dismissal.
 *
 * A partial run that produced something - a calendar, a draft - is not a
 * failure to announce: the person can open what it made, and the run screen
 * already says what is missing.
 */
export interface FailedRunNotice {
  runId: string;
  tone: "partial" | "error";
  line: string;
}

export function failedRunNotice(snapshot: OnboardingRunSnapshot | null): FailedRunNotice | null {
  const run = snapshot?.run;
  if (!run) return null;
  if (run.status === "running" && !snapshot.stale) return null;
  const state = stateFromRun(run, snapshot.article, { stale: snapshot.stale });
  const outcome = onboardingOutcome(state);
  if (outcome.tone === "error") return { runId: run.id, tone: "error", line: outcome.line };
  if (outcome.tone === "partial" && !outcome.produced) return { runId: run.id, tone: "partial", line: outcome.line };
  return null;
}

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
