import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where every candidate went, as the recommender counts it on the real path.
 *
 * A real signup's site planned four topics on one run and none on the next
 * (2026-09-26 against 2026-09-28), and nothing said which stage had emptied
 * the list. The funnel puts each keyword row in exactly one bucket - the
 * first stage that set it aside - so the buckets must add up to the rows
 * read. Only the paid edges are faked: the business profile and the results
 * judge. Scoring, the free gates, the duplicate pass and the refill are real.
 */

const ensure = vi.fn();
const qualify = vi.fn();
vi.mock("@/lib/keyword-research/business-context", () => ({ ensureBusinessProfile: (...a: unknown[]) => ensure(...a) }));
vi.mock("@/lib/keyword-research/opportunity", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/opportunity")>("@/lib/keyword-research/opportunity");
  return { ...real, qualifyOpportunities: (...a: unknown[]) => qualify(...a) };
});

import { recommendKeywords } from "../recommendations";
import { buildTopicalProfile } from "../topical-profile";
import { funnelDiscrepancy, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import { SpendRefusedError } from "@/lib/billing/spend-gate";
import type { CrawlResult } from "@/lib/audit/crawler";
import type { Opportunity } from "@/lib/keyword-research/opportunity";

const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://acme-cycles.example/", status: 200, title: "", metaDescription: "", h1: [], h2: [], images: [], links: [], loadTimeMs: 0, ...over,
});
const PROFILE = buildTopicalProfile("acme-cycles.example", [
  page({ title: "Bike repair workshop | Acme", h1: ["Bike repair and wheel building"], h2: ["Gravel bike servicing", "Brake bleeding service"] }),
], "2026-09-29T00:00:00.000Z");
const BUSINESS = { description: "Acme is a bike repair workshop: servicing, wheel building and brake work.", audiences: ["commuter cyclists"], offerings: ["bike repair"], competitors: [] };

type Row = Record<string, unknown>;
const row = (id: string, term: string, over: Row = {}): Row => ({
  id, term, volume: 500, difficulty: 10, intent: "info", status: "new", source: "gap", source_type: "competitor",
  source_ref: null, source_url: null, opportunity: null, buyer_fit: { keep: true, reason: "a cyclist", funnel: "buyer" }, plan_excluded_at: null, ...over,
});

const PARKED_AT = "2026-09-28T00:00:00.000Z";
const ROWS: Row[] = [
  // Refused by the buyer test at intake, parked.
  row("fit1", "bike mechanic jobs", { buyer_fit: { keep: false, reason: "a job seeker" }, plan_excluded_at: PARKED_AT, status: "stored",
    opportunity: { version: 2, context: "old", checkedAt: PARKED_AT, status: "rejected", cause: "buyer_mismatch", reason: "a job seeker" } }),
  row("fit2", "bike mechanic course", { buyer_fit: { keep: false, reason: "a student" }, plan_excluded_at: PARKED_AT, status: "stored",
    opportunity: { version: 2, context: "old", checkedAt: PARKED_AT, status: "rejected", cause: "buyer_mismatch", reason: "a student" } }),
  // Taken off the plan by a person: parked, no verdict.
  row("person", "wheel building workshop", { plan_excluded_at: PARKED_AT, status: "stored" }),
  // A page of the site already targets it.
  row("covered", "brake bleeding service"),
  // No volume, no impressions, no position.
  row("nodemand", "bike repair open sundays", { volume: null }),
  // Far beyond an authority-10 site.
  row("reach", "bike repair", { difficulty: 95, volume: 40000 }),
  // Provider fragment: ends in a two-letter token.
  row("quality", "gravel bike servicing co"),
  // A phrasing of the leader below: one search, one article.
  row("dup", "tubeless setup gravel", { volume: 90 }),
  // Through to the results judge.
  row("q1", "gravel tubeless setup", { volume: 210 }),
  row("q2", "disc vs rim brakes", { volume: 70 }),
  row("ne", "chain wear checker", { volume: 300 }),
  row("np", "bike repair shop open weekends", { volume: 260 }),
  row("ep", "bike service cost", { volume: 480 }),
  row("thin", "derailleur hanger alignment tool", { volume: 40 }),
  row("bm", "bike mechanic salary", { volume: 150 }),
  row("unjudged", "wheel truing stand", { volume: 120 }),
];

function client(): SupabaseClient {
  const tables: Record<string, unknown[]> = {
    keywords: ROWS,
    site_pages: [{ url: "https://acme-cycles.example/brakes", keyword: "brake bleeding service" }],
  };
  const chain = (value: { data: unknown[]; error: null; count?: number }): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["eq", "in", "order", "range", "gte", "not", "select", "is", "update", "delete"]) {
      self[m] = (...args: unknown[]) => {
        if (m === "select" && (args[1] as { count?: string } | undefined)?.count) value = { ...value, count: value.data.length };
        if (m === "update") value = { data: [], error: null, count: 1 };
        return Object.assign(Promise.resolve(value), self);
      };
    }
    self.single = async () => ({ data: { topical_profile: PROFILE, dr: 10, business_profile: BUSINESS, domain: "acme-cycles.example", language: "en", location_code: 2124, auto_generate_weekly_limit: 7 } });
    return self;
  };
  return { from: (table: string) => chain({ data: tables[table] ?? [], error: null }) } as unknown as SupabaseClient;
}

const verdict = (status: Opportunity["status"], cause?: Opportunity["cause"]): Opportunity => ({
  version: 2, context: "ctx", checkedAt: "2026-09-29T00:00:00.000Z", status, reason: "stub", ...(cause ? { cause } : {}),
  ...(status === "qualified" ? { organicUrls: [], angle: "x", format: "article" } : {}),
});
const VERDICTS: Record<string, Opportunity> = {
  q1: verdict("qualified"),
  q2: verdict("qualified"),
  ne: verdict("rejected", "not_editorial"),
  np: verdict("rejected", "needs_page"),
  ep: verdict("rejected", "existing_page"),
  thin: verdict("pending", "thin_serp"),
  bm: verdict("rejected", "buyer_mismatch"),
  // "unjudged" gets no answer: the refill had enough before reaching it.
};

beforeEach(() => {
  ensure.mockReset().mockResolvedValue({ business: BUSINESS, inferred: false, missing: null });
  qualify.mockReset().mockImplementation(async (_s: unknown, _w: unknown, asked: Array<{ id: string }>) =>
    new Map(asked.flatMap((c) => (VERDICTS[c.id] ? [[c.id, VERDICTS[c.id]] as const] : []))));
});

async function funnelOf(): Promise<TopicFunnel> {
  const seen: TopicFunnel[] = [];
  await recommendKeywords(client(), "ws", { qualify: true, limit: 1000, onFunnel: (f) => seen.push(f) });
  expect(seen).toHaveLength(1);
  return seen[0];
}

describe("recommendKeywords: the funnel", () => {
  it("puts every row in exactly one stage, and the stages add up to what was read", async () => {
    const f = await funnelOf();
    expect(funnelDiscrepancy(f)).toBeNull();
    expect(f.found).toBe(ROWS.length);
    expect(f.removed).toEqual({
      buyer_fit: 3, // two at intake, one by the buyer test inside qualification
      removed_by_person: 1,
      covered: 1,
      no_demand: 1,
      out_of_reach: 1,
      quality: 1,
      duplicate: 1,
      not_judged: 1,
      thin_serp: 1,
      existing_page: 1,
      needs_page: 1,
      not_editorial: 1,
    });
    expect(f.qualified).toBe(2);
    expect(f.judged).toBe(7);
  });

  it("counts the rows qualification never reached as refused when the spend gate says no, and still throws", async () => {
    const refusal = new SpendRefusedError({ allowed: false, reason: "trial-required", quota: {} as never, message: "Start the trial." });
    qualify.mockReset().mockRejectedValue(refusal);
    const seen: TopicFunnel[] = [];
    await expect(recommendKeywords(client(), "ws", { qualify: true, limit: 1000, onFunnel: (f) => seen.push(f) })).rejects.toBe(refusal);
    expect(seen).toHaveLength(1);
    const f = seen[0];
    expect(funnelDiscrepancy(f)).toBeNull();
    expect(f.found).toBe(ROWS.length);
    // Every row the free gates let through: nothing was judged.
    expect(f.removed.spend_refused).toBe(8);
    expect(f.qualified).toBe(0);
  });

  it("is not called without a listener, and changes no decision when there is one", async () => {
    const without = await recommendKeywords(client(), "ws", { qualify: true, limit: 1000 });
    const withIt = await recommendKeywords(client(), "ws", { qualify: true, limit: 1000, onFunnel: () => undefined });
    const shape = (rs: typeof without) => rs.map((r) => [r.keywordId, r.action, r.quality, r.opportunity?.status ?? null]);
    expect(shape(withIt)).toEqual(shape(without));
  });
});
