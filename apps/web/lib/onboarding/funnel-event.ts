// ---------------------------------------------------------------------------
// The onboarding run's topic funnel, written down for an operator
// ---------------------------------------------------------------------------
//
// A real signup's site planned four topics on 2026-09-26 and none for the same
// site two days later, and neither run said where its candidates went: the
// planning line reads "No keyword clear enough to plan yet" for every empty
// plan. Every run now leaves one `onboarding.funnel` event in system_events
// (shown on /admin/events): found, removed at each stage, qualified, planned,
// and why each qualified topic the planner left out was left out.
// Counts only - no terms - so the row says nothing about the customer's
// market that the keywords table does not already hold.
//
// The event is built by a pure function so its shape can be tested; the write
// goes through `recordEvent`, which never throws and never blocks a run.

import { recordEvent, type SystemEvent } from "@/lib/observability/record";
import { describeFunnel, funnelDiscrepancy, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import type { RunBudgetState } from "@/lib/billing/run-budget";
import { timingSummary, type RunTimings } from "./timings";

export const FUNNEL_EVENT_SOURCE = "onboarding.funnel";

export interface PlanFunnelEventInput {
  runId?: string | null;
  workspaceId: string;
  accountId?: string | null;
  /** Null when the planner never read candidates (a spent trial hold, a full calendar, no keywords). */
  funnel: TopicFunnel | null;
  /** The planning phase's own sentence, for a run with no funnel to show. */
  planningDetail?: string | null;
  /**
   * The run's budget after the drafting phase (lib/billing/run-budget.ts):
   * what each stage has spent, and how many claims were refused. A draft
   * written in its own invocation comes after this event; its reserve is
   * still held on the row.
   */
  spend?: RunBudgetState | null;
  /** The first draft was written in this invocation, so `spend` includes it. */
  draftIncluded?: boolean;
  /**
   * Where the run's time went so far (./timings.ts), summarised: per-stage
   * start, end, busy time and calls, and the named moments. Milliseconds
   * since the run began; no terms.
   */
  timings?: RunTimings | null;
}

/** The spend, said at the end of the message line. Empty without a budget. */
function spendSentence(spend: ReturnType<typeof spendContext>, draftIncluded: boolean): string {
  if (!spend) return "";
  const refused = Number(spend.refused) || 0;
  return `. Spent $${Number(spend.spentUsd).toFixed(4)} of $${Number(spend.ceilingUsd).toFixed(2)} ${draftIncluded ? "with the draft" : "before the draft"}${refused ? `; ${refused} paid read${refused === 1 ? "" : "s"} refused by the budget, left not judged` : ""}`;
}

/** The budget as the event carries it: USD per stage, the total, the refusals. */
export function spendContext(spend: RunBudgetState | null | undefined): Record<string, unknown> | null {
  if (!spend) return null;
  const byStage: Record<string, { spentUsd: number; calls: number; refused?: number }> = {};
  let spent = 0;
  for (const [stage, s] of Object.entries(spend.stages)) {
    const spentUsd = Math.round((s?.spent ?? 0) * 1e6) / 1e6;
    spent += spentUsd;
    byStage[stage] = { spentUsd, calls: s?.calls ?? 0, ...(s?.refused ? { refused: s.refused } : {}) };
  }
  return {
    ceilingUsd: spend.ceilingUsd,
    spentUsd: Math.round(spent * 1e6) / 1e6,
    committedUsd: spend.committedUsd,
    refused: spend.refused,
    byStage,
  };
}

/**
 * The event for one run. A plan with nothing on it is a warning: it is the
 * case an operator has to explain to the person who signed up.
 */
export function planFunnelEvent(input: PlanFunnelEventInput): SystemEvent {
  const event = funnelEventOf(input);
  // The timings ride along only while the context fits the event's cap: past
  // it the whole context would be replaced with a note, and the funnel is
  // what this event is for. The full table is on the run row either way.
  const context = event.context as Record<string, unknown>;
  if (context.timings && JSON.stringify(context).length > TIMINGS_CONTEXT_ROOM) {
    event.context = { ...context, timings: "omitted: see onboarding_runs.timings" };
  }
  return event;
}

/** Below the event's 4,000-character cap, with room for the sanitiser's quoting. */
const TIMINGS_CONTEXT_ROOM = 3_600;

function funnelEventOf(input: PlanFunnelEventInput): SystemEvent {
  const base = { source: FUNNEL_EVENT_SOURCE, workspaceId: input.workspaceId, accountId: input.accountId ?? null };
  const spend = spendContext(input.spend);
  const timings = timingSummary(input.timings);
  const f = input.funnel;
  if (!f) {
    return {
      ...base,
      level: "info",
      message: `The planner read no candidates this run${input.planningDetail ? `: ${input.planningDetail}` : "."}`,
      context: { runId: input.runId ?? null, ...(spend ? { spend } : {}), ...(timings ? { timings } : {}) },
    };
  }
  // Written down, not thrown: the funnel is instrumentation and a miscount
  // must not cost the run its plan. The event says so where it is read.
  const discrepancy = funnelDiscrepancy(f);
  return {
    ...base,
    level: (f.planned ?? f.qualified) > 0 && !discrepancy ? "info" : "warn",
    message: `Topic funnel: ${describeFunnel(f)}${discrepancy ? ` (counts do not add up: ${discrepancy})` : ""}${spendSentence(spend, input.draftIncluded === true)}`,
    context: {
      runId: input.runId ?? null,
      found: f.found,
      qualified: f.qualified,
      planned: f.planned ?? null,
      notPlanned: f.notPlanned ?? null,
      judged: f.judged ?? null,
      removed: f.removed,
      ...(f.lowerConfidence ? { lowerConfidence: f.lowerConfidence } : {}),
      ...(f.unmeasured ? { unmeasured: f.unmeasured } : {}),
      ...(f.plannedLowerConfidence ? { plannedLowerConfidence: f.plannedLowerConfidence } : {}),
      ...(spend ? { spend } : {}),
      ...(timings ? { timings } : {}),
      // What each judged results page was, counts only (the page-type rule).
      ...(f.pageReads?.length ? { pageReads: f.pageReads } : {}),
      ...(f.overruled ? { overruled: f.overruled } : {}),
    },
  };
}

/** Write the run's funnel event. Resolves whatever happens. */
export async function recordPlanFunnel(input: PlanFunnelEventInput): Promise<void> {
  await recordEvent(planFunnelEvent(input));
}

export const TIMING_EVENT_SOURCE = "onboarding.timing";

/**
 * The whole run's timing table, once the first article's body has landed:
 * the worker's stages and the draft route's on one axis (./timings.ts). The
 * funnel event is written before the draft, so it cannot carry the draft's
 * half. Seconds and counts only. Resolves whatever happens.
 */
export async function recordRunTiming(input: { runId: string; workspaceId: string; accountId?: string | null; timings: RunTimings | null; outcome: string }): Promise<void> {
  const summary = timingSummary(input.timings);
  if (!summary) return;
  const marks = Object.entries(summary.marks).map(([k, v]) => `${k} ${v}s`).join(", ");
  await recordEvent({
    level: "info",
    source: TIMING_EVENT_SOURCE,
    workspaceId: input.workspaceId,
    accountId: input.accountId ?? null,
    message: `First look timing (${input.outcome})${marks ? `: ${marks}` : ""}`,
    context: { runId: input.runId, outcome: input.outcome, ...summary },
  });
}
