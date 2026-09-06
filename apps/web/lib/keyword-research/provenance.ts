// ---------------------------------------------------------------------------
// What the drawer writes into keywords.source_type / source_ref
// ---------------------------------------------------------------------------
//
// The dashboard's "Keyword sources" block rolls these two columns up, and
// until now every keyword the research drawer inserted left them null, so
// the highest-volume insert path was invisible to the block that exists to
// measure it. A candidate that knows its input (a competitor domain, an
// audience, a playbook) keeps that; one that only knows how it was researched
// records the research kind. Pure, so the insert and its test agree.

import type { ResearchCandidate, ResearchKind } from "./types";

export interface KeywordProvenance {
  source_type: string;
  source_ref: string | null;
}

/** keywords.source_type for a candidate that carries no finer provenance. */
const KIND_SOURCE: Record<ResearchKind, string> = {
  generate: "generate",
  playbook: "playbook",
  chat: "chat",
  manual: "manual",
  import: "import",
};

export function keywordProvenance(candidate: ResearchCandidate, kind: ResearchKind): KeywordProvenance {
  if (candidate.source) {
    const ref = candidate.source.ref?.trim() || null;
    return { source_type: candidate.source.type, source_ref: ref };
  }
  return { source_type: KIND_SOURCE[kind], source_ref: null };
}
