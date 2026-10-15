import { describe, expect, it, vi, beforeEach } from "vitest";

const post = vi.fn();
vi.mock("@/lib/seo/client", () => ({ post: (...a: unknown[]) => post(...a) }));

import { fetchTermMetrics } from "../metrics";

// 2026-10-15: a 402 on the overview was caught upstream and became "no row for
// any of 25 terms". A failure must reach the caller as a failure.
describe("fetchTermMetrics", () => {
  const terms = Array.from({ length: 25 }, (_, i) => `electric bike topic ${i}`);
  beforeEach(() => { post.mockReset(); });

  it("throws when the provider call fails", async () => {
    post.mockImplementation(async () => { throw new Error("DataForSEO API error: 402 Payment Required"); });
    const caught = await fetchTermMetrics(terms).then(() => null, (e: unknown) => e);
    expect(String(caught)).toMatch(/402 Payment Required/);
  });

  it("throws on an envelope with no task in it: no answer is not an empty answer", async () => {
    post.mockResolvedValue({ status_code: 20000, cost: 0, tasks: [] });
    await expect(fetchTermMetrics(terms)).rejects.toThrow(/no answer for 25 terms/);
  });

  it("returns an empty map when the provider answered and knows none of the terms", async () => {
    post.mockResolvedValue({ status_code: 20000, cost: 0.0125, tasks: [{ status_code: 20000, result: [{ items_count: 0, items: null }] }] });
    const out = await fetchTermMetrics(terms);
    expect(out.size).toBe(0);
  });
});
