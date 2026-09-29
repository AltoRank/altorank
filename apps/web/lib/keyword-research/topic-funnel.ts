// ---------------------------------------------------------------------------
// Where every candidate topic went: the planner's funnel, as numbers that add up
// ---------------------------------------------------------------------------
//
// A real signup's site planned four topics on one run and none on the next
// (2026-09-26 against 2026-09-28), and nothing on either run said where the
// candidates had gone. The planning line said "No keyword clear enough to
// plan yet", which is true of every empty plan and explains none of them;
// finding out took an export of every keyword row and a hand count.
//
// So every candidate the recommender reads is put in exactly one bucket: the
// first stage, in the order the pipeline applies them, that set it aside - or
// `qualified` if nothing did. The buckets sum to what was found, and a test
// holds them to it (__tests__/topic-funnel.test.ts). One vocabulary for the
// onboarding run's event, the eval harness and the notes: the recommender
// (lib/seo/recommendations.ts) and the harness (lib/evals) both count through
// `tallyFunnel`, and nothing else decides which bucket a verdict is.
//
// Pure: no database, no model, safe to import from anywhere.

import type { Opportunity, OpportunityCause } from "./opportunity";

/**
 * The stages, in the order the pipeline applies them. A candidate is counted
 * at the first one that removed it.
 */
export const FUNNEL_STAGES = [
  // Before the recommender scores anything.
  "buyer_fit",
  "removed_by_person",
  // The recommender's own gates, free.
  "covered",
  "off_topic",
  "no_demand",
  "out_of_reach",
  "quality",
  "duplicate",
  // Qualification, which buys a results page and a verdict.
  "spend_refused",
  "not_judged",
  "no_profile",
  "no_verdict",
  "provider_error",
  "thin_serp",
  "judge_incomplete",
  "existing_page",
  "needs_page",
  "not_editorial",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type FunnelOutcome = FunnelStage | "qualified";

/** What each stage means, in the words an operator reads on the events page. */
export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  buyer_fit: "buyer test refused",
  removed_by_person: "taken off the plan by a person",
  covered: "already ranking, or a page or article of the site targets it",
  off_topic: "searcher has decided not to buy",
  no_demand: "no measured demand",
  out_of_reach: "difficulty out of reach",
  quality: "provider noise",
  duplicate: "same search as another topic",
  spend_refused: "spend gate refused qualification",
  not_judged: "not judged this pass (queue full or batch cap)",
  no_profile: "no business profile to judge against",
  no_verdict: "buyer test gave no decision",
  provider_error: "provider call failed",
  thin_serp: "too few results to judge",
  judge_incomplete: "judge answer unusable",
  existing_page: "judge: an own page ranks for it",
  needs_page: "judge: wants a landing page",
  not_editorial: "judge: results are not articles",
};

/** The shorter name used in one-line summaries and table headers. */
export const FUNNEL_STAGE_SHORT: Record<FunnelStage, string> = {
  buyer_fit: "buyer fit",
  removed_by_person: "removed by person",
  covered: "covered",
  off_topic: "off topic",
  no_demand: "no demand",
  out_of_reach: "out of reach",
  quality: "quality",
  duplicate: "duplicate",
  spend_refused: "spend refused",
  not_judged: "not judged",
  no_profile: "no profile",
  no_verdict: "no verdict",
  provider_error: "provider error",
  thin_serp: "thin serp",
  judge_incomplete: "judge incomplete",
  existing_page: "existing page",
  needs_page: "needs page",
  not_editorial: "not editorial",
};

/**
 * Why a qualified topic was not put on the calendar, in the order the planner
 * checks (lib/onboarding/plan.ts). A run that read "5 qualified -> 3 planned"
 * did not say where the other two went; these do, and a qualified topic is
 * either planned or counted at exactly one of them.
 */
export const PLANNER_STAGES = [
  "refused",
  "excluded",
  "on_calendar",
  "not_writable",
  "same_as_calendar",
  "same_search",
  "no_room",
] as const;

export type PlannerStage = (typeof PLANNER_STAGES)[number];

export const PLANNER_STAGE_LABELS: Record<PlannerStage, string> = {
  refused: "the pass ended on a spend refusal before planning",
  excluded: "taken off the plan by a person",
  on_calendar: "already on the calendar",
  not_writable: "not offered to the planner as writable",
  same_as_calendar: "same search as a calendar entry",
  same_search: "same search as a topic planned ahead of it",
  no_room: "no room: calendar full, pace or the run's entry cap",
};

export const PLANNER_STAGE_SHORT: Record<PlannerStage, string> = {
  refused: "refused",
  excluded: "excluded",
  on_calendar: "on calendar",
  not_writable: "not writable",
  same_as_calendar: "same as calendar",
  same_search: "same search",
  no_room: "no room",
};

export interface TopicFunnel {
  /** Every candidate read. Always the sum of `removed` and `qualified`. */
  found: number;
  /** How many each stage removed; stages that removed none are left out. */
  removed: Partial<Record<FunnelStage, number>>;
  /** Approved by the results judge and not a repeat of another approval. */
  qualified: number;
  /** Of the qualified, how many the planner put on the calendar. Absent until a planner has run. */
  planned?: number;
  /**
   * Where the qualified topics the planner did not take went, one stage each;
   * with `planned`, sums to `qualified`. Absent until a planner has run.
   */
  notPlanned?: Partial<Record<PlannerStage, number>>;
  /** Verdicts bought this pass (results judge plus buyer test), when known. */
  judged?: number;
}

const CAUSE_STAGE: Record<OpportunityCause, FunnelStage> = {
  buyer_mismatch: "buyer_fit",
  duplicate: "duplicate",
  unjudged: "not_judged",
  no_profile: "no_profile",
  no_verdict: "no_verdict",
  provider_error: "provider_error",
  thin_serp: "thin_serp",
  judge_incomplete: "judge_incomplete",
  existing_page: "existing_page",
  needs_page: "needs_page",
  not_editorial: "not_editorial",
};

/**
 * The bucket a qualification verdict puts a candidate in. A verdict with no
 * cause is either an approval or one the product wrote before causes existed;
 * the second is counted as not judged, never as qualified.
 */
export function stageOfVerdict(verdict: Pick<Opportunity, "status" | "cause">): FunnelOutcome {
  if (verdict.status === "qualified") return "qualified";
  return verdict.cause ? CAUSE_STAGE[verdict.cause] ?? "not_judged" : "not_judged";
}

/** Count outcomes, one per candidate. */
export function tallyFunnel(outcomes: Iterable<FunnelOutcome>, extra: Pick<TopicFunnel, "judged"> = {}): TopicFunnel {
  const removed: Partial<Record<FunnelStage, number>> = {};
  let found = 0;
  let qualified = 0;
  for (const outcome of outcomes) {
    found++;
    if (outcome === "qualified") qualified++;
    else removed[outcome] = (removed[outcome] ?? 0) + 1;
  }
  return { found, removed, qualified, ...(extra.judged !== undefined ? { judged: extra.judged } : {}) };
}

/** Sum of every removal. */
export function totalRemoved(funnel: TopicFunnel): number {
  return FUNNEL_STAGES.reduce((sum, stage) => sum + (funnel.removed[stage] ?? 0), 0);
}

/**
 * Whether the numbers add up: every candidate in one bucket, nothing planned
 * that was not qualified. Returns the discrepancy in words, or null.
 */
export function funnelDiscrepancy(funnel: TopicFunnel): string | null {
  const removed = totalRemoved(funnel);
  const unknown = Object.keys(funnel.removed).filter((k) => !(FUNNEL_STAGES as readonly string[]).includes(k));
  if (unknown.length) return `unknown stage ${unknown.join(", ")}`;
  if (Object.values(funnel.removed).some((n) => !Number.isInteger(n) || (n as number) < 0)) return "a stage count is not a non-negative integer";
  if (removed + funnel.qualified !== funnel.found) return `${funnel.found} found, but ${removed} removed + ${funnel.qualified} qualified = ${removed + funnel.qualified}`;
  if (funnel.planned !== undefined && funnel.planned > funnel.qualified) return `${funnel.planned} planned from ${funnel.qualified} qualified`;
  if (funnel.notPlanned) {
    const unknownPlanner = Object.keys(funnel.notPlanned).filter((k) => !(PLANNER_STAGES as readonly string[]).includes(k));
    if (unknownPlanner.length) return `unknown planner stage ${unknownPlanner.join(", ")}`;
    if (Object.values(funnel.notPlanned).some((n) => !Number.isInteger(n) || (n as number) < 0)) return "a planner stage count is not a non-negative integer";
    const left = totalNotPlanned(funnel);
    const planned = funnel.planned ?? 0;
    if (planned + left !== funnel.qualified) return `${funnel.qualified} qualified, but ${planned} planned + ${left} not planned = ${planned + left}`;
  }
  return null;
}

/** Sum of every qualified topic the planner did not take. */
export function totalNotPlanned(funnel: TopicFunnel): number {
  return PLANNER_STAGES.reduce((sum, stage) => sum + (funnel.notPlanned?.[stage] ?? 0), 0);
}

/** The funnel with the planner's count on it, and where the rest went when known. */
export function withPlanned(funnel: TopicFunnel, planned: number, notPlanned?: Partial<Record<PlannerStage, number>>): TopicFunnel {
  return { ...funnel, planned, ...(notPlanned ? { notPlanned } : {}) };
}

/**
 * One line: "216 found: 160 buyer fit, 24 no demand, 9 not editorial -> 5
 * qualified -> 4 planned (not planned: 1 same search)". Stages in pipeline
 * order, the empty ones left out.
 */
export function describeFunnel(funnel: TopicFunnel): string {
  const parts = FUNNEL_STAGES.filter((s) => (funnel.removed[s] ?? 0) > 0).map((s) => `${funnel.removed[s]} ${FUNNEL_STAGE_SHORT[s]}`);
  const head = `${funnel.found} found${parts.length ? `: ${parts.join(", ")}` : ""}`;
  const rest = PLANNER_STAGES.filter((s) => (funnel.notPlanned?.[s] ?? 0) > 0).map((s) => `${funnel.notPlanned![s]} ${PLANNER_STAGE_SHORT[s]}`);
  const planned = funnel.planned !== undefined ? ` -> ${funnel.planned} planned${rest.length ? ` (not planned: ${rest.join(", ")})` : ""}` : "";
  return `${head} -> ${funnel.qualified} qualified${planned}`;
}

/**
 * Several funnels side by side as a markdown table, one column per funnel and
 * one row per stage any of them used. For the eval report and the notes.
 */
export function funnelTable(columns: ReadonlyArray<{ label: string; funnel: TopicFunnel }>): string {
  const used = FUNNEL_STAGES.filter((s) => columns.some((c) => (c.funnel.removed[s] ?? 0) > 0));
  const cells = (pick: (f: TopicFunnel) => number | undefined) => columns.map((c) => { const n = pick(c.funnel); return n === undefined ? "–" : String(n); });
  const lines = [
    `| stage | ${columns.map((c) => c.label).join(" | ")} |`,
    `|---|${columns.map(() => "---:").join("|")}|`,
    `| found | ${cells((f) => f.found).join(" | ")} |`,
    ...used.map((s) => `| − ${FUNNEL_STAGE_SHORT[s]} | ${cells((f) => f.removed[s] ?? 0).join(" | ")} |`),
    `| **qualified** | ${cells((f) => f.qualified).join(" | ")} |`,
  ];
  const plannerUsed = PLANNER_STAGES.filter((s) => columns.some((c) => (c.funnel.notPlanned?.[s] ?? 0) > 0));
  lines.push(...plannerUsed.map((s) => `| − ${PLANNER_STAGE_SHORT[s]} | ${cells((f) => (f.notPlanned ? f.notPlanned[s] ?? 0 : undefined)).join(" | ")} |`));
  if (columns.some((c) => c.funnel.planned !== undefined)) lines.push(`| planned | ${cells((f) => f.planned).join(" | ")} |`);
  return lines.join("\n");
}
