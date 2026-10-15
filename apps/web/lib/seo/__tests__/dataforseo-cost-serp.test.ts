import { describe, it, expect } from "vitest";
import { estimateDataForSEOUsd } from "@/lib/seo/dataforseo-cost";

const SERP = "/serp/google/organic/live/advanced";

describe("results page estimate", () => {
  it("prices a plain page at one page of ten", () => {
    expect(estimateDataForSEOUsd(SERP, [{ keyword: "x" }])).toBeCloseTo(0.004, 6);
  });

  it("adds the asynchronous AI Overview and each People Also Ask click", () => {
    // Billed $0.0027 on average across ten rich pages (2026-10-15); the
    // estimate stays above the worst case: $0.002 page + $0.002 overview + $0.00015 click.
    const rich = estimateDataForSEOUsd(SERP, [{ keyword: "x", load_async_ai_overview: true, people_also_ask_click_depth: 1 }]);
    expect(rich).toBeCloseTo(0.00615, 6);
    expect(rich).toBeGreaterThanOrEqual(0.002 + 0.002 + 0.00015);
  });
});
