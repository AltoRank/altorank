// ---------------------------------------------------------------------------
// The signup funnel, for the operator's Funnel page and a user's own page
// ---------------------------------------------------------------------------
//
// One journey per signed-up user, built from rows the product already writes:
//
//   auth.users                 when they signed up
//   system_events `signup`     where they came from (./user-origin.ts)
//   system_events `onboarding.step`  each step the wizard, the gate and the
//                              checkout reached (lib/onboarding/step-names.ts)
//   onboarding_runs            how each first look ended, and whether it wrote
//   articles                   a draft at all, from a run or the nightly cron
//   accounts                   the plan Stripe's webhook mirrored, and the
//                              "how did you hear of us" answer
//
// Nothing is estimated: a stage is reached when its own row exists, and a
// stage with no row is not filled in from a later one. Pure: the pages read
// the rows, this reads them.

import type { UserOrigin } from "./user-origin";

/** The stages of a signup, in the order one meets them. */
export const FUNNEL_STAGES = [
  { key: "signed_up", label: "Signed up" },
  { key: "wizard_opened", label: "Opened setup" },
  { key: "site_read", label: "Site read" },
  { key: "run_started", label: "First look started" },
  { key: "draft_written", label: "Draft written" },
  { key: "gate_shown", label: "Saw the gate" },
  { key: "offer_seen", label: "Read the offer" },
  { key: "trial_clicked", label: "Clicked start trial" },
  { key: "trial_started", label: "Trial started" },
  { key: "paid", label: "Paying" },
] as const;
export type FunnelStageKey = (typeof FUNNEL_STAGES)[number]["key"];

/** The onboarding.step name that marks each stage, where a step does. */
const STEP_OF_STAGE: Partial<Record<FunnelStageKey, string>> = {
  wizard_opened: "wizard_opened",
  site_read: "site_read_finished",
  run_started: "run_started",
  gate_shown: "gate_shown",
  offer_seen: "offer_seen",
  trial_clicked: "trial_clicked",
  trial_started: "trial_started",
};

/** Our own addresses and test signups: the same test the signup export applies. */
const INTERNAL_EMAIL = /(altorank|supalabs|sensefound|mikececco|example[.]|[+]test|@test)/i;
export function isInternalEmail(email: string | null | undefined): boolean {
  return INTERNAL_EMAIL.test(email ?? "");
}

export interface FunnelUser {
  id: string;
  email: string | null;
  createdAt: string;
}
export interface FunnelStepEvent {
  created_at: string;
  context: unknown;
}
export interface FunnelRun {
  account_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  article_id: string | null;
  keywords_found: number | null;
  phases: unknown;
  error: string | null;
}
export interface FunnelAccount {
  id: string;
  plan_status: string | null;
  attribution_source: string | null;
}

export interface Journey {
  userId: string;
  email: string | null;
  createdAt: string;
  site: string | null;
  origin: UserOrigin;
  /** The landing page of the visit, else the page signup was clicked on. */
  page: string | null;
  /** The account's own answer to "how did you hear of us", if it gave one. */
  declared: string | null;
  /** When each stage was reached; absent when it was not. */
  at: Partial<Record<FunnelStageKey, string>>;
  /** Stages known only from the plan on the account: reached, at a time nobody recorded. */
  undated: FunnelStageKey[];
  /** The last stage reached, in funnel order. */
  furthest: FunnelStageKey;
  /** How the newest first look ended, in the run's own words, when it wrote nothing. */
  runOutcome: string | null;
  runs: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const earliest = (a: string | undefined, b: string | null | undefined): string | undefined =>
  !b ? a : !a || b < a ? b : a;

/** Each user's first time at each onboarding step, by user id then step name. */
export function firstStepsByUser(events: FunnelStepEvent[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const e of events) {
    const ctx = e.context && typeof e.context === "object" ? (e.context as Record<string, unknown>) : null;
    const userId = str(ctx?.userId);
    const step = str(ctx?.step);
    if (!userId || !step) continue;
    const steps = out.get(userId) ?? new Map<string, string>();
    const seen = steps.get(step);
    if (!seen || e.created_at < seen) steps.set(step, e.created_at);
    out.set(userId, steps);
  }
  return out;
}

/**
 * Why a first look wrote no article: the detail of the phase that did not
 * finish, as the run recorded it. Null for a run that wrote one.
 */
export function runOutcome(run: FunnelRun | undefined): string | null {
  if (!run || run.article_id) return null;
  if (run.status === "running") return "Still running";
  if (run.error) return run.error;
  const phases = Array.isArray(run.phases) ? (run.phases as Array<Record<string, unknown>>) : [];
  const stuck = phases.find((p) => p.status && p.status !== "done");
  const detail = str(stuck?.detail);
  if (detail) return `${str(stuck?.phase) ?? "run"}: ${detail}`;
  return `Finished ${run.status} with no article`;
}

/**
 * A run outcome with its numbers and names taken out, so "23 keywords kept of
 * 67" and "15 keywords kept of 19" count as one reason.
 */
export function outcomeReason(outcome: string): string {
  return outcome.replace(/\d+([.,]\d+)?/g, "N").replace(/\s+/g, " ").slice(0, 110);
}

export function buildJourney(input: {
  user: FunnelUser;
  origin: UserOrigin;
  page: string | null;
  account: FunnelAccount | undefined;
  site: string | null;
  steps: Map<string, string> | undefined;
  runs: FunnelRun[];
  /** created_at of the account's first article, from a run or the cron. */
  firstArticleAt: string | null;
}): Journey {
  const { user, steps, account } = input;
  const runs = [...input.runs].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const at: Journey["at"] = { signed_up: user.createdAt };
  for (const stage of FUNNEL_STAGES) {
    const step = STEP_OF_STAGE[stage.key];
    const seen = step ? steps?.get(step) : undefined;
    if (seen) at[stage.key] = seen;
  }
  // The run row is the server's own record of a start; the step event can be
  // missing for runs older than the event.
  at.run_started = earliest(at.run_started, runs[0]?.started_at);
  const wrote = runs.find((r) => r.article_id);
  at.draft_written = earliest(wrote?.finished_at ?? undefined, input.firstArticleAt);
  // Stripe's webhook mirrors the plan onto the account without a time of its
  // own here: the stage is reached, and its time is marked as not recorded.
  const undated: FunnelStageKey[] = [];
  const fromPlan = (key: FunnelStageKey) => {
    if (at[key]) return;
    at[key] = at.trial_clicked ?? user.createdAt;
    undated.push(key);
  };
  if (account?.plan_status === "trialing" || account?.plan_status === "active") fromPlan("trial_started");
  if (account?.plan_status === "active") fromPlan("paid");
  for (const key of Object.keys(at) as FunnelStageKey[]) if (!at[key]) delete at[key];

  let furthest: FunnelStageKey = "signed_up";
  for (const stage of FUNNEL_STAGES) if (at[stage.key]) furthest = stage.key;

  return {
    userId: user.id,
    email: user.email,
    createdAt: user.createdAt,
    site: input.site,
    origin: input.origin,
    page: input.page,
    declared: str(account?.attribution_source),
    at,
    undated,
    furthest,
    runOutcome: at.draft_written ? null : runOutcome(runs[runs.length - 1]),
    runs: runs.length,
  };
}

export interface FunnelRow {
  key: FunnelStageKey;
  label: string;
  /** Users with this stage's own row. */
  reached: number;
  /** Share of the whole cohort, 0-1. */
  ofCohort: number;
  /** Share of the stage before it, 0-1; null for the first. */
  ofPrevious: number | null;
  /** Users whose journey ends here. */
  stoppedHere: number;
  /** Median minutes from signup to this stage, among those who reached it. */
  medianMinutes: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function funnelRows(journeys: Journey[]): FunnelRow[] {
  const total = journeys.length;
  let previous: number | null = null;
  return FUNNEL_STAGES.map((stage) => {
    const here = journeys.filter((j) => j.at[stage.key]);
    const minutes = here
      .filter((j) => !j.undated.includes(stage.key))
      .map((j) => (new Date(j.at[stage.key] as string).getTime() - new Date(j.createdAt).getTime()) / 60000)
      .filter((m) => m >= 0);
    const row: FunnelRow = {
      key: stage.key,
      label: stage.label,
      reached: here.length,
      ofCohort: total ? here.length / total : 0,
      ofPrevious: previous === null ? null : previous ? here.length / previous : 0,
      stoppedHere: journeys.filter((j) => j.furthest === stage.key).length,
      medianMinutes: stage.key === "signed_up" ? null : median(minutes),
    };
    previous = here.length;
    return row;
  });
}

/** Why first looks wrote nothing, most common first. */
export function runOutcomeRows(journeys: Journey[]): Array<{ reason: string; users: number; sites: string[] }> {
  const by = new Map<string, string[]>();
  for (const j of journeys) {
    if (!j.runOutcome) continue;
    const reason = outcomeReason(j.runOutcome);
    by.set(reason, [...(by.get(reason) ?? []), j.site ?? "no site"]);
  }
  return [...by.entries()]
    .map(([reason, sites]) => ({ reason, users: sites.length, sites }))
    .sort((a, b) => b.users - a.users);
}

export type AcquisitionDimension = "source" | "page" | "declared";

export interface AcquisitionRow {
  value: string;
  signups: number;
  drafts: number;
  gate: number;
  trialClicks: number;
  trials: number;
  paid: number;
}

const NONE: Record<AcquisitionDimension, string> = {
  source: "Not recorded",
  page: "No page on the link",
  declared: "Not answered",
};

function dimensionValue(j: Journey, dimension: AcquisitionDimension): string {
  if (dimension === "source") return j.origin.kind === "unknown" ? NONE.source : j.origin.label;
  if (dimension === "page") return j.page ?? NONE.page;
  return j.declared ?? NONE.declared;
}

/** Signups and how far they got, per source, landing page or declared channel. The "none" row sorts last. */
export function acquisitionRows(journeys: Journey[], dimension: AcquisitionDimension): AcquisitionRow[] {
  const by = new Map<string, AcquisitionRow>();
  for (const j of journeys) {
    const value = dimensionValue(j, dimension);
    const row = by.get(value) ?? { value, signups: 0, drafts: 0, gate: 0, trialClicks: 0, trials: 0, paid: 0 };
    row.signups += 1;
    if (j.at.draft_written) row.drafts += 1;
    if (j.at.gate_shown) row.gate += 1;
    if (j.at.trial_clicked) row.trialClicks += 1;
    if (j.at.trial_started) row.trials += 1;
    if (j.at.paid) row.paid += 1;
    by.set(value, row);
  }
  const none = NONE[dimension];
  return [...by.values()].sort(
    (a, b) => Number(a.value === none) - Number(b.value === none) || b.signups - a.signups || a.value.localeCompare(b.value),
  );
}

/** Signups per UTC day over the trailing `days`, oldest first, empty days included. */
export function signupsByDay(journeys: Journey[], days: number, now: Date): Array<{ day: string; n: number }> {
  const counts = new Map<string, number>();
  for (const j of journeys) {
    const day = j.createdAt.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const out: Array<{ day: string; n: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, n: counts.get(day) ?? 0 });
  }
  return out;
}

/** One line of a user's own page: something that happened, and when. */
export interface TimelineEntry {
  at: string;
  kind: "account" | "step" | "run" | "article" | "email" | "gate" | "event";
  level: "info" | "warn" | "error";
  what: string;
  detail: string | null;
}

/** Every entry in the order it happened; entries with no time are dropped. */
export function timeline(entries: Array<TimelineEntry | null | undefined | false>): TimelineEntry[] {
  return entries
    .filter((e): e is TimelineEntry => Boolean(e && e.at))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** "4 min", "3 h", "2 d": a span an operator reads at a glance. */
export function spanLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "< 1 min";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 36 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}
