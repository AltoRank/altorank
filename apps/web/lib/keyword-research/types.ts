// ---------------------------------------------------------------------------
// Shapes shared by the research pipeline, its server actions and the drawer
// ---------------------------------------------------------------------------

import type { KeywordIntent } from "@/lib/types";

export type ResearchKind = "generate" | "playbook" | "chat" | "manual" | "import";

export type ResearchSource = "both" | "competitors" | "audiences";

/**
 * One researched keyword, before anyone has decided what to do with it.
 *
 * Every metric is nullable. `null` means the provider did not report it, and
 * the table renders it as an em dash. It is never 0: a 0 reads as "nobody
 * searches this" or "trivially easy", and both are claims we cannot make.
 */
export interface ResearchCandidate {
  term: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: KeywordIntent;
  /** Where this one came from, in words a person would say. */
  origin: string;
  /** Set when a keyword row already exists for this term in the workspace. */
  existingId: string | null;
  existingStatus: string | null;
}

/** The count at every stage. Shown verbatim after a run. */
export interface ResearchFunnel {
  found: number;
  skippedNoData: number;
  skippedLowVolume: number;
  skippedExisting: number;
  proposed: number;
}

export interface ResearchResult {
  runId: string | null;
  kind: ResearchKind;
  candidates: ResearchCandidate[];
  funnel: ResearchFunnel;
  /** One line per step, e.g. "Researched 3 competitors → 22 candidates". */
  trace: string[];
  /** Why there is nothing, when there is nothing. Never a blank table. */
  note: string | null;
}

export interface PlanCapacity {
  scheduled: number;
  cap: number;
  slots: number;
}
