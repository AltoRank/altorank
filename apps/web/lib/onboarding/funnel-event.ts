// ---------------------------------------------------------------------------
// The onboarding run's topic funnel, written down for an operator
// ---------------------------------------------------------------------------
//
// A real signup's site planned four topics on 2026-09-26 and none for the same
// site two days later, and neither run said where its candidates went: the
// planning line reads "No keyword clear enough to plan yet" for every empty
// plan. Every run now leaves one `onboarding.funnel` event in system_events
// (shown on /admin/events): found, removed at each stage, qualified, planned.
// Counts only - no terms - so the row says nothing about the customer's
// market that the keywords table does not already hold.
//
// The event is built by a pure function so its shape can be tested; the write
// goes through `recordEvent`, which never throws and never blocks a run.

import { recordEvent, type SystemEvent } from "@/lib/observability/record";
import { describeFunnel, funnelDiscrepancy, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";

export const FUNNEL_EVENT_SOURCE = "onboarding.funnel";

export interface PlanFunnelEventInput {
  runId?: string | null;
  workspaceId: string;
  accountId?: string | null;
  /** Null when the planner never read candidates (a spent trial hold, a full calendar, no keywords). */
  funnel: TopicFunnel | null;
  /** The planning phase's own sentence, for a run with no funnel to show. */
  planningDetail?: string | null;
}

/**
 * The event for one run. A plan with nothing on it is a warning: it is the
 * case an operator has to explain to the person who signed up.
 */
export function planFunnelEvent(input: PlanFunnelEventInput): SystemEvent {
  const base = { source: FUNNEL_EVENT_SOURCE, workspaceId: input.workspaceId, accountId: input.accountId ?? null };
  const f = input.funnel;
  if (!f) {
    return {
      ...base,
      level: "info",
      message: `The planner read no candidates this run${input.planningDetail ? `: ${input.planningDetail}` : "."}`,
      context: { runId: input.runId ?? null },
    };
  }
  // Written down, not thrown: the funnel is instrumentation and a miscount
  // must not cost the run its plan. The event says so where it is read.
  const discrepancy = funnelDiscrepancy(f);
  return {
    ...base,
    level: (f.planned ?? f.qualified) > 0 && !discrepancy ? "info" : "warn",
    message: `Topic funnel: ${describeFunnel(f)}${discrepancy ? ` (counts do not add up: ${discrepancy})` : ""}`,
    context: {
      runId: input.runId ?? null,
      found: f.found,
      qualified: f.qualified,
      planned: f.planned ?? null,
      judged: f.judged ?? null,
      removed: f.removed,
    },
  };
}

/** Write the run's funnel event. Resolves whatever happens. */
export async function recordPlanFunnel(input: PlanFunnelEventInput): Promise<void> {
  await recordEvent(planFunnelEvent(input));
}
