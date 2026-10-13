// ---------------------------------------------------------------------------
// The eval run as the planner's funnel: where the labelled terms went
// ---------------------------------------------------------------------------
//
// The same buckets the onboarding run writes to system_events
// (lib/keyword-research/topic-funnel.ts), counted over a case's end-to-end
// ("pipeline") items twice: once from the labels, once from what the product
// answered. Side by side they say which stage empties a plan - on 2026-09-28
// a real signup's site went from four planned topics to none, and the eval
// is where "the judge called 27 labelled topics not editorial" shows up as a
// number rather than a disagreement list.
//
// Only terms the eval can decide end to end are counted: the recommender's
// free gates (demand, reach, provider noise) need the keyword table, which a
// case does not carry.

import { stageOfVerdict, tallyFunnel, type FunnelOutcome, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import type { OpportunityCause } from "@/lib/keyword-research/opportunity";
import type { Scored } from "./types";

export interface CaseFunnel {
  caseId: string;
  /** What the labels say the funnel should be. */
  labels: TopicFunnel;
  /** What the product's decisions made of it. */
  product: TopicFunnel;
}

/** A pipeline label or answer ("qualified", "buyer_mismatch", "not_editorial", ...) as a funnel bucket. */
export function outcomeOf(verdict: string): FunnelOutcome {
  if (verdict === "qualified") return "qualified";
  return stageOfVerdict({ status: "rejected", cause: verdict as OpportunityCause });
}

/** One funnel pair per case, from the pipeline items, in case order. */
export function caseFunnels(items: readonly Scored[]): CaseFunnel[] {
  const byCase = new Map<string, Scored[]>();
  for (const s of items) {
    if (s.decision !== "pipeline") continue;
    const list = byCase.get(s.caseId) ?? [];
    list.push(s);
    byCase.set(s.caseId, list);
  }
  return [...byCase].map(([caseId, list]) => ({
    caseId,
    labels: tallyFunnel(list.map((s) => outcomeOf(s.expected))),
    product: tallyFunnel(list.map((s) => outcomeOf(s.predicted))),
  }));
}
