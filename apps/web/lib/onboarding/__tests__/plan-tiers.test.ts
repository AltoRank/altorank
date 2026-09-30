import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/plan/__tests__/fake-postgrest";

/**
 * The planner chooses its plan by value tier (lib/keyword-research/
 * value-tiers.ts): T1 first, at most one T2 and one T3 of five, a first look
 * relaxing to fill T1's share with labelled lower-confidence picks, the page
 * type enforced in code, and the funnel saying where every qualified topic
 * went. The recommender is replaced by its output; the planner, the grid,
 * the calendar write and the funnel are real.
 */

const { recs, hold } = vi.hoisted(() => ({ recs: [] as Array<Record<string, unknown>>, hold: { value: "open" as "open" | "held" } }));
vi.mock("@/lib/billing/trial-hold", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/trial-hold")>()),
  planHold: async () => hold.value,
  planHoldApplies: async () => hold.value === "held",
}));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: async (_s: unknown, _w: unknown, options: { onFunnel?: (f: unknown, q: ReadonlySet<string>) => void }) => {
    const qualified = recs.filter((r) => (r.opportunity as { status?: string } | undefined)?.status === "qualified");
    options.onFunnel?.({ found: recs.length, removed: recs.length - qualified.length ? { needs_page: recs.length - qualified.length } : {}, qualified: qualified.length }, new Set(qualified.map((r) => r.keywordId as string)));
    return recs;
  },
}));
vi.mock("@/lib/keywords/questions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keywords/questions")>()),
  generateQualityQuestionsBatch: async () => new Map(),
}));

import { schedulePlan } from "../plan";
import { describeFunnel, funnelDiscrepancy, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import type { Opportunity } from "@/lib/keyword-research/opportunity";

const FROM = new Date("2026-10-01T09:00:00.000Z");
let n = 0;
/** A recommender row: an approval of `value` at `winnability`, or a refusal when `cause` is given. */
function rec(id: string, value: 0 | 1 | 2 | 3, winnability: number, extra: { volume?: number; cause?: Opportunity["cause"]; format?: string; term?: string } = {}) {
  const urls = [`https://a${++n}.example/`, `https://b${n}.example/`, `https://c${n}.example/`];
  const tier = value >= 2 && winnability >= 0.5 ? "t1" : value === 3 ? "t2" : value === 1 && winnability >= 0.5 ? "t3" : "inventory";
  const opportunity = extra.cause
    ? { status: "rejected", cause: extra.cause, reason: String(extra.cause), organicUrls: urls }
    : { status: "qualified", format: extra.format ?? "article", value, reason: "r", organicUrls: urls, evidenceUrls: urls.slice(0, 2), checkedAt: FROM.toISOString() };
  return {
    keywordId: id, term: extra.term ?? `topic ${id}`, action: extra.cause ? "skip" : "write", quality: "ok", intent: "commercial",
    volume: extra.volume ?? 100, winnability, score: 1, reasons: [], ...(extra.cause ? {} : { tier }), opportunity,
  };
}

function db() {
  return new FakeDb({
    calendar_entries: [],
    keywords: recs.map((r) => ({ id: r.keywordId, workspace_id: "ws1", term: r.term, status: "new", plan_excluded_at: null, opportunity: r.opportunity })),
    workspaces: [{ id: "ws1", account_id: "acc1", auto_generate_weekly_limit: 7, business_profile: null, domain: "acme-cycles.example", language: "en", location_code: 2124 }],
  });
}

async function plan(opts: { firstLook?: boolean; maxEntries?: number } = {}) {
  const d = db();
  let funnel: TopicFunnel | undefined;
  const entries = await schedulePlan(d.client, "ws1", 7, {
    maxEntries: opts.maxEntries ?? 5, from: FROM, onFunnel: (f) => { funnel = f; },
    ...(opts.firstLook === false ? {} : { firstLook: { since: FROM.toISOString() } }),
  });
  return { d, entries, funnel: funnel! };
}

beforeEach(() => {
  recs.length = 0;
  hold.value = "open";
});

describe("the plan by value tier", () => {
  it("plans T1 first, one T2 and one T3, and leaves the rest in inventory with the reason counted", async () => {
    recs.push(
      rec("general", 1, 0.9, { volume: 50_000 }), rec("general2", 1, 0.9, { volume: 40_000 }),
      rec("service", 3, 0.9, { volume: 20 }), rec("problem", 2, 0.9, { volume: 400 }), rec("problem2", 2, 0.8),
      rec("bet", 3, 0.2), rec("bet2", 3, 0.1), rec("hard", 2, 0.2),
      rec("page", 3, 0.9, { cause: "needs_page" }),
    );
    const { entries, funnel } = await plan();
    expect(entries.map((e) => `${e.keywordId}:${e.brief?.tier}${e.brief?.confidence ? "*" : ""}`)).toEqual(["service:t1", "problem:t1", "problem2:t1", "bet:t2", "general:t3"]);
    expect(funnel).toMatchObject({ qualified: 8, planned: 5, plannedTiers: { t1: 3, t2: 1, t3: 1 }, notPlanned: { tier_full: 2, inventory: 1 } });
    expect(funnelDiscrepancy(funnel)).toBeNull();
    expect(describeFunnel(funnel)).toContain("5 planned (3 T1, 1 T2, 1 T3; not planned: 1 inventory, 2 tier full)");
  });

  it("relaxes on a first look short of T1: the next T2, labelled lower confidence on the calendar's rows, never a second top-of-funnel topic", async () => {
    recs.push(rec("problem", 2, 0.9), rec("bet", 3, 0.2), rec("bet2", 3, 0.1), rec("tof", 1, 0.9, { volume: 900 }), rec("tof2", 1, 0.9), rec("tof3", 1, 0.9));
    const { d, entries, funnel } = await plan();
    expect(entries.map((e) => `${e.keywordId}:${e.brief?.tier}${e.brief?.confidence ? "*" : ""}`)).toEqual(["problem:t1", "bet:t2", "bet2:t2*", "tof:t3"]);
    expect(funnel).toMatchObject({ planned: 4, plannedLowerConfidence: 1, notPlanned: { tier_full: 2 } });
    expect(funnelDiscrepancy(funnel)).toBeNull();
    // The label is saved on the row the calendar and the first-article card read.
    const saved = Object.fromEntries(d.rows("keywords").map((r) => [r.id, r.opportunity as Opportunity]));
    expect(saved.bet2).toMatchObject({ tier: "t2", confidence: "lower" });
    expect(saved.tof).toMatchObject({ tier: "t3" });
    expect(saved.tof.confidence).toBeUndefined();
  });

  it("does not relax on a nightly top-up", async () => {
    recs.push(rec("problem", 2, 0.9), rec("bet", 3, 0.2), rec("bet2", 3, 0.1), rec("tof", 1, 0.9), rec("tof2", 1, 0.9));
    const { entries, funnel } = await plan({ firstLook: false });
    expect(entries.map((e) => e.keywordId)).toEqual(["problem", "bet", "tof"]);
    expect(funnel.notPlanned).toEqual({ tier_full: 2 });
  });

  it("fills a first look from a value-2 topic out of reach, labelled, and never from general interest out of reach", async () => {
    recs.push(rec("hard", 2, 0.2), rec("hardgeneral", 1, 0.1));
    const { entries, funnel } = await plan();
    expect(entries.map((e) => `${e.keywordId}:${e.brief?.tier}${e.brief?.confidence ? "*" : ""}`)).toEqual(["hard:t2*"]);
    expect(funnel).toMatchObject({ qualified: 2, planned: 1, notPlanned: { inventory: 1 } });
    // A nightly top-up plans neither.
    expect((await plan({ firstLook: false })).entries).toEqual([]);
  });

  it("enforces the page type in code: an approval on a page that is not editorial never reaches the plan", async () => {
    recs.push(rec("good", 3, 0.9), rec("odd", 3, 0.9, { format: "product" }));
    const { entries, funnel } = await plan();
    expect(entries.map((e) => e.keywordId)).toEqual(["good"]);
    expect(funnel.notPlanned).toEqual({ not_writable: 1 });
  });
});

describe("a calendar held at its first article (an account before its trial)", () => {
  beforeEach(() => { hold.value = "held"; });

  it("chooses its one topic by the first-article rule, not by plan order", async () => {
    // The service topic leads the plan, but it needs clinical claims; the
    // problem topic passes the rule and is the one scheduled.
    recs.push(
      rec("tof", 1, 0.9, { volume: 20_000, term: "teeth whitening tips" }),
      rec("claims", 3, 0.9, { volume: 5_000, term: "tooth extraction recovery time" }),
      rec("clean", 2, 0.9, { volume: 300, term: "dentist for sensitive teeth" }),
    );
    const { entries, funnel } = await plan();
    expect(entries.map((e) => e.term)).toEqual(["dentist for sensitive teeth"]);
    expect(funnel).toMatchObject({ planned: 1 });
    expect(funnelDiscrepancy(funnel)).toBeNull();
  });

  it("takes the fact-risk fallback when every topic of value 2 or more needs the owner's facts", async () => {
    recs.push(rec("claims", 3, 0.9, { term: "tooth extraction recovery time" }), rec("tof", 1, 0.9, { volume: 90_000 }));
    const { entries } = await plan();
    expect(entries.map((e) => e.term)).toEqual(["tooth extraction recovery time"]);
  });

  it("plans nothing when only top-of-funnel topics qualified, and says the first-article rule is why", async () => {
    recs.push(rec("tof", 1, 0.9, { volume: 20_000 }), rec("tof2", 1, 0.9));
    const { entries, funnel } = await plan();
    expect(entries).toEqual([]);
    expect(funnel).toMatchObject({ qualified: 2, planned: 0, notPlanned: { first_article: 1, tier_full: 1 } });
    expect(funnelDiscrepancy(funnel)).toBeNull();
  });
});
