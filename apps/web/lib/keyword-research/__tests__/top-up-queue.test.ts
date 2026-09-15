import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The nightly top-up researches only when the qualified queue needs it, and
 * what it stores has met the buyer test: a refusal is parked with its
 * verdict rather than dropped, and never reaches the writer.
 */

const { countReady, judge, price, head } = vi.hoisted(() => ({ countReady: vi.fn(), judge: vi.fn(), price: vi.fn(), head: vi.fn() }));
vi.mock("../queue", async (original) => ({ ...(await original<object>()), countReady }));
vi.mock("../buyer-fit", () => ({ judgeBuyerFit: judge }));
vi.mock("../metrics", () => ({ fetchTermMetrics: price }));
vi.mock("../category", () => ({ resolveSeedHead: head }));

import { topUpKeywords } from "../top-up";

const BUSINESS = { name: "Qasimcode", description: "Qasimcode builds appointment-based websites for clinics, salons and studios.", audiences: ["Dental clinics"], offerings: ["clinic booking websites"], competitors: [] };
let inserted: Record<string, unknown>[] = [];
const db = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self, not: self,
      single: async () => ({ data: { domain: "qasimcode.com", dr: 10, business_profile: BUSINESS, topical_profile: { terms: { clinic: 2, website: 2, booking: 2, salon: 1 }, topTerms: ["clinic", "website"] }, language: "en", location_code: 2840, auto_generate_weekly_limit: 7 } }),
      insert: async (rows: Record<string, unknown>[]) => { inserted.push(...rows); return { error: null }; },
      then: (r: (v: unknown) => unknown) => r({ data: table === "articles" ? [{ research: { relatedKeywords: [{ keyword: "clinic website design" }, { keyword: "free website builder" }] } }] : [], error: null }),
    });
    return chain;
  },
} as never;

beforeEach(() => {
  inserted = [];
  for (const m of [countReady, judge, price, head]) m.mockReset();
  head.mockResolvedValue({ head: null, priced: false, seedVolume: 0, tried: [] });
  price.mockResolvedValue(new Map([
    ["clinic website design", { term: "clinic website design", volume: 400, difficulty: 20, cpc: 2, intent: "commercial" }],
    ["free website builder", { term: "free website builder", volume: 9000, difficulty: 30, cpc: 1, intent: "commercial" }],
  ]));
  judge.mockResolvedValue({ basis: "model", verdicts: new Map([
    ["clinic website design", { keep: true, reason: null }],
    ["free website builder", { keep: false, reason: "wants a free tool, not a studio" }],
  ]) });
});

describe("topUpKeywords and the queue", () => {
  it("does nothing when the queue already holds what the pace needs", async () => {
    countReady.mockResolvedValue(10);
    const out = await topUpKeywords(db, "ws");
    expect(out.reason).toBe("the queue holds 10 qualified topics; nothing new is needed until it drops under 10");
    expect(price).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("researches when the queue is short, and parks what the buyer test refuses with its verdict", async () => {
    countReady.mockResolvedValue(2);
    const out = await topUpKeywords(db, "ws");
    expect(price).toHaveBeenCalledOnce();
    expect(judge).toHaveBeenCalledOnce();
    // Playbook phrases the profile generates ride along unpriced; the point
    // here is the two the judge answered.
    expect(out.inserted).toBeGreaterThanOrEqual(1);
    expect(out.parked).toBe(1);
    const kept = inserted.find((r) => r.term === "clinic website design")!;
    const parked = inserted.find((r) => r.term === "free website builder")!;
    expect(kept.status).toBe("new");
    expect(kept.plan_excluded_at).toBeNull();
    expect(parked.status).toBe("stored");
    expect(parked.plan_excluded_at).toEqual(expect.any(String));
    expect(parked.opportunity).toMatchObject({ status: "rejected", cause: "buyer_mismatch", reason: "wants a free tool, not a studio" });
  });
});
