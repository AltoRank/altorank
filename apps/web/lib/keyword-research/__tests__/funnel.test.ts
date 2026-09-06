import { describe, expect, it } from "vitest";
import {
  applyFunnel,
  capacityLine,
  dedupeCandidates,
  funnelLine,
  isEasyWin,
  markExisting,
  parseTermList,
  planCapacity,
  rankCandidates,
  PLAN_MAX_ENTRIES,
} from "../funnel";
import type { ResearchCandidate } from "../types";

const c = (term: string, volume: number | null, difficulty: number | null = null, over: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
  term,
  volume,
  difficulty,
  cpc: null,
  intent: "info",
  origin: "test",
  existingId: null,
  existingStatus: null,
  ...over,
});

describe("isEasyWin", () => {
  it("needs both numbers and the thresholds", () => {
    expect(isEasyWin(c("a", 100, 30))).toBe(true);
    expect(isEasyWin(c("a", 99, 30))).toBe(false);
    expect(isEasyWin(c("a", 100, 31))).toBe(false);
    expect(isEasyWin(c("a", 5000, null))).toBe(false);
    expect(isEasyWin(c("a", null, 5))).toBe(false);
  });
});

describe("planCapacity", () => {
  it("counts down from the cap and never goes negative", () => {
    expect(planCapacity(12)).toEqual({ scheduled: 12, cap: PLAN_MAX_ENTRIES, slots: 48 });
    expect(planCapacity(75).slots).toBe(0);
    expect(capacityLine(planCapacity(59))).toBe("59 of 60 scheduled · 1 slot available");
    expect(capacityLine(planCapacity(0))).toBe("0 of 60 scheduled · 60 slots available");
  });
});

describe("dedupe and existing", () => {
  it("collapses word-order and plural variants, keeping the best-searched phrasing", () => {
    const out = dedupeCandidates([c("agency seo", 1000), c("seo for agencies", 1200), c("agency for seo", 1200)]);
    expect(out).toHaveLength(1);
    // Two at 1,200: the shorter phrasing wins the tie.
    expect(out[0].term).toBe("agency for seo");
  });
  it("marks a candidate tracked when the workspace holds any phrasing of it", () => {
    const [a, b] = markExisting([c("seo for agencies", 10), c("crm software", 10)], [{ id: "k1", term: "agency seo", status: "planned" }]);
    expect(a.existingId).toBe("k1");
    expect(a.existingStatus).toBe("planned");
    expect(b.existingId).toBeNull();
  });
});

describe("rankCandidates", () => {
  it("puts easy wins first, then volume, and unknown volume last", () => {
    const out = rankCandidates([c("big", 50000, 80), c("unknown", null, null), c("easy", 300, 10), c("mid", 900, 60)]);
    expect(out.map((x) => x.term)).toEqual(["easy", "big", "mid", "unknown"]);
  });
});

describe("applyFunnel", () => {
  const raw = [
    c("crm software", 500, 20),
    c("ghost term", null),
    c("tiny niche", 10),
    c("big term", 2000, 55),
    c("easy pick", 700, 25),
    c("agency seo", 900, 30),
    c("seo for agencies", 950, 30),
  ];
  const existing = [{ id: "k1", term: "seo agency", status: "planned" }];

  it("accounts for every row and proposes the rest, capped by limit", () => {
    const { candidates, funnel } = applyFunnel(raw, existing, { limit: 2 });
    expect(funnel).toEqual({ found: 6, skippedNoData: 1, skippedLowVolume: 1, skippedExisting: 1, proposed: 2 });
    expect(candidates.map((x) => x.term)).toEqual(["easy pick", "crm software"]);
  });
  it("found + drops + kept adds up before the limit", () => {
    const { funnel } = applyFunnel(raw, existing);
    expect(funnel.found).toBe(funnel.skippedNoData + funnel.skippedLowVolume + funnel.skippedExisting + funnel.proposed);
  });
  it("keeps no-data and already-tracked rows when asked (Find and Import)", () => {
    const { candidates, funnel } = applyFunnel(raw, existing, { keepExisting: true, keepNoData: true, minVolume: 0 });
    expect(funnel.skippedNoData).toBe(0);
    expect(funnel.skippedExisting).toBe(0);
    expect(funnel.skippedLowVolume).toBe(0);
    expect(candidates).toHaveLength(6);
    expect(candidates.find((x) => x.term === "seo for agencies")?.existingStatus).toBe("planned");
    expect(candidates[candidates.length - 1].volume).toBeNull();
  });
});

describe("funnelLine", () => {
  it("only mentions stages that happened, and says scheduled once something is", () => {
    expect(funnelLine({ found: 14, skippedNoData: 3, skippedLowVolume: 2, skippedExisting: 0, proposed: 9 })).toBe(
      "Found 14 · 3 skipped, no search data · 2 skipped, too little volume · 9 proposed",
    );
    expect(funnelLine({ found: 14, skippedNoData: 3, skippedLowVolume: 2, skippedExisting: 0, proposed: 9 }, 5)).toBe(
      "Found 14 · 3 skipped, no search data · 2 skipped, too little volume · 5 scheduled",
    );
    expect(funnelLine({ found: 0, skippedNoData: 0, skippedLowVolume: 0, skippedExisting: 0, proposed: 0 })).toBe("Found 0 · 0 proposed");
  });
});

describe("parseTermList", () => {
  it("splits on commas and newlines, trims, drops blanks and case-duplicates", () => {
    expect(parseTermList("crm software, best CRM\n\n  crm software ,email tool\n")).toEqual(["crm software", "best CRM", "email tool"]);
  });
});
