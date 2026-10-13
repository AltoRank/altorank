import { describe, it, expect } from "vitest";
import { describeEmptyPool } from "../empty-pool";

describe("describeEmptyPool", () => {
  it("names research as the stage when there was nothing to judge", () => {
    expect(describeEmptyPool([])).toMatchObject({ stage: "keywords", cause: null, keywords: 0, qualified: 0 });
  });

  it("names qualification, and the verdict that removed the most, when nothing qualified", () => {
    // The shape of a real signup's first look on 2026-09-28: mostly rejected
    // as not a buyer search, a handful for other causes, some never judged.
    const rows = [
      ...Array.from({ length: 110 }, () => ({ status: "rejected", cause: "buyer_mismatch" })),
      ...Array.from({ length: 4 }, () => ({ status: "rejected", cause: "not_editorial" })),
      { status: "rejected", cause: "needs_page" },
      ...Array.from({ length: 24 }, () => ({ status: null, cause: null })),
      { status: "pending", cause: "thin_serp" },
    ];
    const pool = describeEmptyPool(rows);
    expect(pool).toMatchObject({
      stage: "qualification",
      cause: "buyer_mismatch",
      keywords: 140,
      qualified: 0,
      rejected: { buyer_mismatch: 110, not_editorial: 4, needs_page: 1 },
      pending: { unjudged: 24, thin_serp: 1 },
    });
    expect(pool.summary).toContain("None of 140 searches qualified; the largest group: not a buyer search");
    expect(pool.summary).toContain("24 stored before qualification existed");
  });

  it("falls back to the largest undecided cause when nothing was rejected", () => {
    expect(describeEmptyPool([{ status: "pending", cause: "provider_error" }, { status: "pending", cause: "provider_error" }, { status: "pending", cause: "thin_serp" }])).toMatchObject({
      stage: "qualification",
      cause: "provider_error",
    });
  });

  it("names the planner when something qualified and nothing was placed", () => {
    expect(describeEmptyPool([{ status: "qualified" }, { status: "rejected", cause: "duplicate" }])).toMatchObject({ stage: "planning", qualified: 1, keywords: 2 });
  });
});
