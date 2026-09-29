import { describe, it, expect } from "vitest";
import {
  describeFunnel,
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  FUNNEL_STAGE_SHORT,
  funnelDiscrepancy,
  funnelTable,
  stageOfVerdict,
  tallyFunnel,
  totalRemoved,
  withPlanned,
  type FunnelOutcome,
} from "../topic-funnel";
import type { OpportunityCause } from "../opportunity";

const ALL_CAUSES: OpportunityCause[] = [
  "unjudged", "no_profile", "no_verdict", "thin_serp", "provider_error", "judge_incomplete",
  "buyer_mismatch", "existing_page", "not_editorial", "needs_page", "duplicate",
];

describe("stageOfVerdict", () => {
  it("counts an approval as qualified and every cause as a stage", () => {
    expect(stageOfVerdict({ status: "qualified" })).toBe("qualified");
    for (const cause of ALL_CAUSES) {
      const stage = stageOfVerdict({ status: "rejected", cause });
      expect(FUNNEL_STAGES).toContain(stage);
    }
    expect(stageOfVerdict({ status: "rejected", cause: "buyer_mismatch" })).toBe("buyer_fit");
    expect(stageOfVerdict({ status: "pending", cause: "unjudged" })).toBe("not_judged");
  });

  it("never counts a verdict with no cause as qualified", () => {
    expect(stageOfVerdict({ status: "rejected" })).toBe("not_judged");
    expect(stageOfVerdict({ status: "pending" })).toBe("not_judged");
  });
});

describe("tallyFunnel", () => {
  it("adds up: found is every outcome, each in one bucket", () => {
    const outcomes: FunnelOutcome[] = ["buyer_fit", "buyer_fit", "no_demand", "qualified", "not_editorial", "qualified", "duplicate"];
    const f = tallyFunnel(outcomes, { judged: 4 });
    expect(f).toEqual({ found: 7, removed: { buyer_fit: 2, no_demand: 1, not_editorial: 1, duplicate: 1 }, qualified: 2, judged: 4 });
    expect(totalRemoved(f) + f.qualified).toBe(f.found);
    expect(funnelDiscrepancy(f)).toBeNull();
  });

  it("is empty and balanced for no candidates", () => {
    const f = tallyFunnel([]);
    expect(f).toEqual({ found: 0, removed: {}, qualified: 0 });
    expect(funnelDiscrepancy(f)).toBeNull();
  });
});

describe("funnelDiscrepancy", () => {
  it("names a funnel that does not add up", () => {
    expect(funnelDiscrepancy({ found: 10, removed: { buyer_fit: 5 }, qualified: 2 })).toBe("10 found, but 5 removed + 2 qualified = 7");
  });
  it("names more planned than qualified", () => {
    expect(funnelDiscrepancy(withPlanned({ found: 3, removed: { no_demand: 2 }, qualified: 1 }, 2))).toBe("2 planned from 1 qualified");
  });
  it("names a stage it does not know", () => {
    expect(funnelDiscrepancy({ found: 1, removed: { vibes: 1 } as never, qualified: 0 })).toBe("unknown stage vibes");
  });
});

describe("describing a funnel", () => {
  it("gives one line in pipeline order, leaving empty stages out", () => {
    const f = withPlanned({ found: 216, removed: { not_editorial: 9, buyer_fit: 160, no_demand: 24, needs_page: 8, existing_page: 4, out_of_reach: 7 }, qualified: 4 }, 3);
    expect(describeFunnel(f)).toBe("216 found: 160 buyer fit, 24 no demand, 7 out of reach, 4 existing page, 8 needs page, 9 not editorial -> 4 qualified -> 3 planned");
  });

  it("tabulates several runs side by side, with found, each used stage and qualified", () => {
    const a = withPlanned({ found: 5, removed: { buyer_fit: 3 }, qualified: 2 }, 1);
    const b = { found: 4, removed: { not_editorial: 4 }, qualified: 0 };
    const table = funnelTable([{ label: "run a", funnel: a }, { label: "run b", funnel: b }]);
    expect(table.split("\n")).toEqual([
      "| stage | run a | run b |",
      "|---|---:|---:|",
      "| found | 5 | 4 |",
      "| − buyer fit | 3 | 0 |",
      "| − not editorial | 0 | 4 |",
      "| **qualified** | 2 | 0 |",
      "| planned | 1 | – |",
    ]);
  });

  it("has a label and a short name for every stage", () => {
    for (const s of FUNNEL_STAGES) {
      expect(FUNNEL_STAGE_LABELS[s]).toBeTruthy();
      expect(FUNNEL_STAGE_SHORT[s]).toBeTruthy();
    }
  });
});
