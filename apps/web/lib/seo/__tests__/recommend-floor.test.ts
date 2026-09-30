import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the recommender offers the planner: the unmeasured path, and no
 * floor - a page type no article wins is never promoted into the plan, on
 * the recommender's real code. Only the paid edges are faked (the business
 * profile read and the qualification verdicts); scoring, the free gates, the
 * duplicate pass and the refill run.
 */

const ensure = vi.fn();
const qualify = vi.fn();
vi.mock("@/lib/keyword-research/business-context", () => ({ ensureBusinessProfile: (...a: unknown[]) => ensure(...a) }));
vi.mock("@/lib/keyword-research/opportunity", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/opportunity")>("@/lib/keyword-research/opportunity");
  return { ...real, qualifyOpportunities: (...a: unknown[]) => qualify(...a) };
});

import { demandFirst, pickNextKeyword, recommendKeywords } from "../recommendations";
import { buildTopicalProfile } from "../topical-profile";
import { describeFunnel, funnelDiscrepancy, type TopicFunnel } from "@/lib/keyword-research/topic-funnel";
import { contextKey, type Opportunity } from "@/lib/keyword-research/opportunity";
import type { CrawlResult } from "@/lib/audit/crawler";

const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://acme-cycles.example/", status: 200, title: "", metaDescription: "", h1: [], h2: [], images: [], links: [], loadTimeMs: 0, ...over,
});
const PROFILE = buildTopicalProfile("acme-cycles.example", [
  page({ title: "Bike repair workshop | Acme", h1: ["Bike repair and wheel building"], h2: ["Gravel bike servicing", "Brake bleeding service"] }),
], "2026-09-29T00:00:00.000Z");
const BUSINESS = { description: "Acme is a bike repair workshop: servicing, wheel building and brake work.", audiences: ["commuter cyclists"], offerings: ["bike repair"], competitors: [] };
const CONTEXT = { business: BUSINESS, domain: "acme-cycles.example", languageCode: "en", locationCode: 2124 };

type Row = Record<string, unknown>;
const row = (id: string, term: string, over: Row = {}): Row => ({
  id, term, volume: 500, difficulty: 10, intent: "info", status: "new", source: "gap", source_type: "competitor",
  source_ref: null, source_url: null, opportunity: null, buyer_fit: { keep: true, reason: "a cyclist", funnel: "buyer" }, plan_excluded_at: null, ...over,
});

const updates: Array<{ patch: Row; id: unknown }> = [];
function client(keywords: Row[], options: { business?: Row; location?: number } = {}): SupabaseClient {
  const tables: Record<string, unknown[]> = { keywords };
  const chain = (table: string, value: { data: unknown[]; error: null; count?: number }, patch?: Row): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["eq", "in", "order", "range", "gte", "not", "select", "is", "update", "delete"]) {
      self[m] = (...args: unknown[]) => {
        if (m === "select" && (args[1] as { count?: string } | undefined)?.count) value = { ...value, count: value.data.length };
        if (m === "update") return chain(table, { data: [], error: null, count: 1 }, args[0] as Row);
        if (m === "eq" && patch && args[0] === "id") updates.push({ patch, id: args[1] });
        return Object.assign(Promise.resolve(value), self);
      };
    }
    self.single = async () => ({ data: { topical_profile: PROFILE, dr: 10, business_profile: options.business ?? BUSINESS, domain: CONTEXT.domain, language: "en", location_code: options.location ?? 2124, auto_generate_weekly_limit: 7 } });
    return self;
  };
  return { from: (table: string) => chain(table, { data: tables[table] ?? [], error: null }) } as unknown as SupabaseClient;
}

const now = () => new Date().toISOString();
const ORGANIC = ["https://a.test/guide", "https://b.test/tool", "https://c.test/tool", "https://d.test/tool"];
const approved = (angle: string): Opportunity => ({
  version: 2, context: "ctx", checkedAt: now(), status: "qualified", reason: "served, articles hold it", audience: "cyclists", buyingJob: "fix a bike",
  offering: "bike repair", angle, format: "article", organicUrls: [`https://x.test/${angle}`, `https://y.test/${angle}`], evidenceUrls: [`https://x.test/${angle}`, `https://y.test/${angle}`],
});
const thin = (angle: string, extra: Partial<Opportunity> = {}): Opportunity => ({
  version: 2, context: "ctx", checkedAt: now(), status: "rejected", cause: "not_editorial", reason: "Too few results are articles.",
  audience: "cyclists", buyingJob: "fix a bike", offering: "bike repair", angle, conversionPath: "https://acme-cycles.example",
  organicUrls: ORGANIC.map((u) => `${u}/${angle}`), evidenceUrls: [`${ORGANIC[0]}/${angle}`], ...extra,
});
const rejected = (cause: Opportunity["cause"]): Opportunity => ({ version: 2, context: "ctx", checkedAt: now(), status: "rejected", cause, reason: String(cause) });

let verdicts: Record<string, Opportunity> = {};
let asked: Array<{ id: string; unmeasured?: boolean }> = [];
beforeEach(() => {
  updates.length = 0;
  asked = [];
  ensure.mockReset().mockResolvedValue({ business: BUSINESS, inferred: false, missing: null });
  qualify.mockReset().mockImplementation(async (_s: unknown, _w: unknown, batch: Array<{ id: string; unmeasured?: boolean }>) => {
    asked.push(...batch);
    return new Map(batch.flatMap((c) => (verdicts[c.id] ? [[c.id, verdicts[c.id]] as const] : [])));
  });
});

async function recommend(rows: Row[], options: { firstLook?: boolean; business?: Row; location?: number } = {}) {
  const seen: TopicFunnel[] = [];
  const recs = await recommendKeywords(client(rows, options), "ws", {
    qualify: true, limit: 1000, onFunnel: (f) => seen.push(f), ...(options.firstLook === false ? {} : { firstLook: { since: now() } }),
  });
  return { recs, funnel: seen[0] };
}

describe("unmeasured buyer-kept terms", () => {
  it("reach the judge labelled unmeasured instead of being skipped, and a measured term still comes first", async () => {
    verdicts = { measured: approved("gravel tubeless"), blank: approved("open late"), zero: approved("never") };
    const { recs, funnel } = await recommend([
      row("blank", "bike repair open late fridays", { volume: null, difficulty: null }),
      row("measured", "gravel tubeless setup", { volume: 20 }),
      row("zero", "bike repair open sundays", { volume: 0 }),
      row("unkept", "bike repair open late mondays", { volume: null, buyer_fit: null }),
    ]);
    // Measured first in what the judge is asked, whatever the scores.
    expect(asked.map((c) => c.id)).toEqual(["measured", "blank"]);
    expect(asked.find((c) => c.id === "blank")?.unmeasured).toBe(true);
    const writable = recs.filter((r) => r.action === "write");
    expect(writable.map((r) => r.keywordId)).toEqual(["measured", "blank"]);
    const blank = recs.find((r) => r.keywordId === "blank")!;
    expect(blank.demand).toBe("unmeasured");
    expect(blank.opportunity?.demand).toBe("unmeasured");
    expect(blank.reasons.join(" ")).toContain("unmeasured");
    // Measured at zero, or never kept by the buyer test: still no demand.
    expect(recs.find((r) => r.keywordId === "zero")?.skippedBy).toBe("no_demand");
    expect(recs.find((r) => r.keywordId === "unkept")?.skippedBy).toBe("no_demand");
    expect(funnel).toMatchObject({ qualified: 2, unmeasured: 1 });
    expect(funnelDiscrepancy(funnel)).toBeNull();
  });
  it("are not taken in the markets the provider covers best, nor when they name a rival", async () => {
    verdicts = { blank: approved("open late"), rival: approved("rival") };
    const rows = () => [
      row("blank", "bike repair open late fridays", { volume: null, difficulty: null }),
      row("rival", "spokeshop alternatives", { volume: null, difficulty: null }),
    ];
    const us = await recommend(rows(), { location: 2840 });
    expect(us.recs.find((r) => r.keywordId === "blank")?.skippedBy).toBe("no_demand");
    asked = [];
    const named = await recommend(rows(), { business: { ...BUSINESS, competitors: ["spokeshop.example"] } });
    expect(named.recs.find((r) => r.keywordId === "rival")?.skippedBy).toBe("no_demand");
    expect(named.recs.find((r) => r.keywordId === "blank")?.demand).toBe("unmeasured");
    expect(asked.map((c) => c.id)).toEqual(["blank"]);
  });
  it("orders measured before unmeasured in every ranking", () => {
    const list = [{ demand: "unmeasured" as const, score: 90 }, { score: 10 }, { score: 50 }];
    expect(list.sort(demandFirst).map((r) => r.score)).toEqual([50, 10, 90]);
  });
});

describe("no floor: the page type never relaxes", () => {
  it("offers only what cleared the bar on a first look short of three approvals", async () => {
    verdicts = { good: approved("tubeless"), t1: thin("chain wear"), t2: thin("hanger"), t3: thin("spokes") };
    const { recs, funnel } = await recommend([
      row("good", "gravel tubeless setup", { volume: 30 }),
      row("t1", "chain wear checker", { volume: 900 }),
      row("t2", "derailleur hanger alignment", { volume: 800 }),
      row("t3", "spoke tension chart", { volume: 700 }),
    ]);
    expect(recs.filter((r) => r.action === "write").map((r) => r.keywordId)).toEqual(["good"]);
    for (const id of ["t1", "t2", "t3"]) expect(recs.find((r) => r.keywordId === id)).toMatchObject({ action: "skip", opportunity: { status: "rejected", cause: "not_editorial" } });
    // Nothing is saved as a lower-confidence approval.
    expect(updates.filter((u) => (u.patch.opportunity as Opportunity | undefined)?.confidence === "lower")).toHaveLength(0);
    expect(funnel).toMatchObject({ qualified: 1, removed: { not_editorial: 3 } });
    expect(funnel.lowerConfidence).toBeUndefined();
    expect(funnelDiscrepancy(funnel)).toBeNull();
  });
  it("never reaches for a refused searcher, a landing-page search or a value-0 topic", async () => {
    verdicts = { nav: rejected("buyer_mismatch"), np: rejected("needs_page"), zero: rejected("no_value"), thin: thin("bare") };
    const { recs, funnel } = await recommend([
      row("nav", "acme cycles opening hours"), row("np", "bike repair shop open weekends"),
      row("zero", "bike stand rental"), row("thin", "bike repair open sundays"),
    ]);
    expect(recs.filter((r) => r.action === "write")).toHaveLength(0);
    expect(funnel).toMatchObject({ qualified: 0, removed: { buyer_fit: 1, needs_page: 1, no_value: 1, not_editorial: 1 } });
    expect(describeFunnel(funnel)).toContain("1 value 0");
  });
  it("does not unpark a not_editorial verdict an earlier run saved", async () => {
    const fingerprint = contextKey(CONTEXT);
    const parked = { ...thin("chain wear"), context: fingerprint };
    verdicts = {};
    const { recs } = await recommend([row("old", "chain wear checker", { status: "stored", plan_excluded_at: now(), opportunity: parked })]);
    expect(recs.find((r) => r.keywordId === "old")?.action).toBe("skip");
  });
});

describe("value tiers order the approvals", () => {
  const graded = (angle: string, value: 0 | 1 | 2 | 3, service?: string): Opportunity => ({ ...approved(angle), value, ...(service ? { service } : {}) });
  it("puts value first, then winnability, and leaves volume to break ties; the cron writes the first", async () => {
    verdicts = {
      gen: graded("commuting", 1),
      svc: graded("tubeless cost", 3, "bike repair"),
      prob: graded("brake rub", 2, "bike repair"),
      hardsvc: graded("wheel build cost", 3, "bike repair"),
      hardprob: graded("disc squeal", 2, "bike repair"),
    };
    const { recs } = await recommend([
      row("gen", "bike commuting tips", { volume: 9000, difficulty: 5 }),
      row("svc", "tubeless conversion cost", { volume: 20, difficulty: 10 }),
      row("prob", "brake rub fix", { volume: 400, difficulty: 10 }),
      row("hardsvc", "wheel building cost", { volume: 300, difficulty: 35 }),
      row("hardprob", "disc brake squeal", { volume: 800, difficulty: 35 }),
    ]);
    const writable = recs.filter((r) => r.action === "write");
    expect(writable.map((r) => `${r.keywordId}:${r.tier}`)).toEqual(["prob:t1", "svc:t1", "hardsvc:t2", "gen:t3", "hardprob:inventory"]);
    expect(writable[0].reasons[1]).toBe("Business value 2 (bike repair): about a service you sell, and within reach");
    expect(pickNextKeyword(recs)?.keywordId).toBe("prob");
    // Inventory is kept, never written unattended.
    expect(pickNextKeyword(recs.filter((r) => r.keywordId === "hardprob"))).toBeNull();
  });
  it("keeps the phrasing closer to a service when two phrasings are one search, whatever their volumes", async () => {
    const shared = ["https://p.test/a", "https://p.test/b", "https://p.test/c", "https://p.test/d"];
    verdicts = {
      loud: { ...graded("x", 1), organicUrls: shared, evidenceUrls: shared.slice(0, 2) },
      close: { ...graded("y", 3, "bike repair"), organicUrls: shared, evidenceUrls: shared.slice(0, 2) },
    };
    const { recs, funnel } = await recommend([
      row("loud", "bike brake adjustment", { volume: 5000 }),
      row("close", "brake adjustment service cost", { volume: 30 }),
    ]);
    expect(recs.filter((r) => r.action === "write").map((r) => r.keywordId)).toEqual(["close"]);
    expect(recs.find((r) => r.keywordId === "loud")?.skippedBy).toBe("duplicate");
    expect(funnelDiscrepancy(funnel)).toBeNull();
  });
  it("reads a verdict saved before the grade existed as value 1: planned only as top of funnel", async () => {
    verdicts = { old: approved("legacy") };
    const { recs } = await recommend([row("old", "gravel tubeless setup", { volume: 50, difficulty: 5 })]);
    expect(recs.find((r) => r.keywordId === "old")?.tier).toBe("t3");
  });
});
