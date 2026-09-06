import { describe, expect, it } from "vitest";
import { keywordProvenance } from "../provenance";
import type { ResearchCandidate } from "../types";

const cand = (extra: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
  term: "crm software",
  volume: 100,
  difficulty: null,
  cpc: null,
  intent: "info",
  origin: "t",
  existingId: null,
  existingStatus: null,
  ...extra,
});

describe("keywordProvenance", () => {
  it("keeps the input behind a candidate when the pipeline recorded one", () => {
    expect(keywordProvenance(cand({ source: { type: "competitor", ref: "semrush.com" } }), "generate")).toEqual({
      source_type: "competitor",
      source_ref: "semrush.com",
    });
    expect(keywordProvenance(cand({ source: { type: "audience", ref: "founders" } }), "chat")).toEqual({
      source_type: "audience",
      source_ref: "founders",
    });
    expect(keywordProvenance(cand({ source: { type: "playbook", ref: "alternatives" } }), "playbook")).toEqual({
      source_type: "playbook",
      source_ref: "alternatives",
    });
  });
  it("records an audience run that named several audiences as audience with no ref, not as one of them", () => {
    expect(keywordProvenance(cand({ source: { type: "audience", ref: null } }), "generate")).toEqual({ source_type: "audience", source_ref: null });
    expect(keywordProvenance(cand({ source: { type: "audience", ref: "  " } }), "generate").source_ref).toBeNull();
  });
  it("falls back to the research kind when the candidate has no finer provenance", () => {
    expect(keywordProvenance(cand(), "chat")).toEqual({ source_type: "chat", source_ref: null });
    expect(keywordProvenance(cand(), "manual")).toEqual({ source_type: "manual", source_ref: null });
    expect(keywordProvenance(cand(), "import")).toEqual({ source_type: "import", source_ref: null });
    expect(keywordProvenance(cand(), "generate")).toEqual({ source_type: "generate", source_ref: null });
  });
});
