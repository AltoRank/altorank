import { describe, it, expect } from "vitest";
import {
  normalizeDomain,
  DOMAIN_PATTERN,
  pickClosestWins,
  pickGaps,
  planCadence,
  buildGrowthPlan,
} from "../build";
import type { RankedKeyword } from "@/lib/seo/ranked-keywords";

const kw = (keyword: string, position: number | null, volume: number | null, url = "https://a.com/blog/x"): RankedKeyword => ({
  keyword, position, url, volume, difficulty: null, cpc: null, isBlogUrl: true,
});

describe("normalizeDomain", () => {
  it("strips scheme, www, paths and case", () => {
    expect(normalizeDomain(" HTTPS://www.Example.com/blog?x=1 ")).toBe("example.com");
    expect(DOMAIN_PATTERN.test(normalizeDomain("https://example.co.uk/"))).toBe(true);
    expect(DOMAIN_PATTERN.test("not a domain")).toBe(false);
  });
});

describe("pickClosestWins", () => {
  it("keeps page-two terms only, largest volume first, one per term, with the path", () => {
    const wins = pickClosestWins([
      kw("already page one", 1, 5000),
      kw("close", 12, 900, "https://a.com/blog/close/"),
      kw("closer", 7, 300),
      kw("close", 14, 900, "https://a.com/other"),
      kw("far away", 45, 9000),
      kw("unranked", null, 100),
    ]);
    expect(wins.map((w) => w.keyword)).toEqual(["close", "closer"]);
    expect(wins[0].path).toBe("/blog/close");
    expect(wins[0].position).toBe(12);
  });
  it("keeps one term per page, the biggest", () => {
    const wins = pickClosestWins([
      kw("variant b", 6, 100, "https://a.com/p"),
      kw("variant a", 5, 900, "https://a.com/p/"),
      kw("other page", 9, 50, "https://a.com/q"),
    ]);
    expect(wins.map((w) => [w.keyword, w.path])).toEqual([["variant a", "/p"], ["other page", "/q"]]);
  });
});

describe("pickGaps", () => {
  it("returns page-one competitor terms the site lacks, merged across competitors", () => {
    const own = [kw("shared term", 3, 1000), kw("widget analysis", 25, 10)];
    const gaps = pickGaps(own, [
      { domain: "b.com", ranked: [kw("shared term", 2, 1000), kw("widget gap one", 4, 800), kw("widget deep", 40, 5000), kw("widget tiny", 1, 10)] },
      { domain: "c.com", ranked: [kw("widget gap one", 9, 800), kw("widget gap two", 1, 300)] },
    ]);
    expect(gaps.map((g) => g.keyword)).toEqual(["widget gap one", "widget gap two"]);
    expect(gaps[0].rankedBy).toEqual([
      { domain: "b.com", position: 4 },
      { domain: "c.com", position: 9 },
    ]);
  });
  it("puts terms both competitors hold first and drops competitor brand names", () => {
    const gaps = pickGaps([kw("technical audit checklist", 12, 100), kw("quirk", 30, 10)], [
      { domain: "semrush.com", ranked: [kw("semrush pricing", 1, 90000), kw("huge quirk", 1, 50000), kw("seo audit", 3, 800), kw("anonib", 1, 246000), kw("ahref", 1, 5400)] },
      { domain: "ahrefs.com", ranked: [kw("ahrefs vs semrush", 1, 20000), kw("seo audit", 6, 800), kw("only ahrefs", 2, 5000), kw("audit checklist", 4, 300)] },
    ]);
    // "only ahrefs" and "ahref" name a competitor; "anonib" shares no word with
    // anything the target ranks for. Shared terms lead, then singles by volume.
    expect(gaps.map((g) => g.keyword)).toEqual(["seo audit", "huge quirk", "audit checklist"]);
    expect(gaps[0].rankedBy).toEqual([
      { domain: "semrush.com", position: 3 },
      { domain: "ahrefs.com", position: 6 },
    ]);
  });
});

describe("planCadence", () => {
  it("promises four a month, wins first", () => {
    const c = planCadence(
      [{ keyword: "w1", position: 8, volume: 1, path: "/" }, { keyword: "w2", position: 9, volume: 1, path: "/" }],
      [{ keyword: "g1", volume: 1, difficulty: null, rankedBy: [] }, { keyword: "g2", volume: 1, difficulty: null, rankedBy: [] }, { keyword: "g3", volume: 1, difficulty: null, rankedBy: [] }],
    );
    expect(c.articlesPerMonth).toBe(4);
    expect(c.firstTargets).toEqual(["w1", "w2", "g1", "g2"]);
    expect(c.firstPublishDays).toBe(5);
  });
});

describe("buildGrowthPlan", () => {
  it("degrades to readiness-only when rank data fails, and records why", async () => {
    const plan = await buildGrowthPlan("https://www.example.com/", {
      ranked: async () => { throw new Error("no credentials"); },
      competitors: async () => [],
      readiness: async (domain) => ({
        domain,
        result: { domain, score: 60, findings: [
          { check: "sitemap", passed: false, severity: "low", detail: "no sitemap" },
          { check: "entity_schema", passed: false, severity: "high", detail: "no Organization" },
          { check: "single_h1", passed: true, severity: "low", detail: "ok" },
        ] },
        proposals: [], notes: [], artifacts: [],
      }),
    });
    expect(plan.domain).toBe("example.com");
    expect(plan.closestWins).toEqual([]);
    expect(plan.gaps).toEqual([]);
    expect(plan.readiness.score).toBe(60);
    // High severity first.
    expect(plan.readiness.failing.map((f) => f.check)).toEqual(["entity_schema", "sitemap"]);
    expect(plan.layers.find((l) => l.id === "ranked")).toMatchObject({ ok: false, detail: "no credentials" });
    expect(plan.layers.find((l) => l.id === "competitors")?.ok).toBe(false);
  });

  it("compares against at most two competitors and never the target", async () => {
    const calls: string[] = [];
    const plan = await buildGrowthPlan("a.com", {
      ranked: async (d) => { calls.push(d); return d === "a.com" ? [kw("mine widgets", 12, 500)] : [kw("theirs widgets", 3, 700)]; },
      competitors: async () => [
        { domain: "b.com", sharedKeywords: 90, avgPosition: null, estimatedTraffic: null },
        { domain: "c.com", sharedKeywords: 80, avgPosition: null, estimatedTraffic: null },
        { domain: "d.com", sharedKeywords: 70, avgPosition: null, estimatedTraffic: null },
        { domain: "e.com", sharedKeywords: 5, avgPosition: null, estimatedTraffic: null },
      ],
      readiness: async (domain) => ({ domain, result: { domain, score: 100, findings: [] }, proposals: [], notes: [], artifacts: [] }),
    });
    expect(calls).toEqual(["a.com", "b.com", "c.com"]);
    expect(plan.competitors.map((c) => c.domain)).toEqual(["b.com", "c.com"]);
    expect(plan.gaps[0]).toMatchObject({ keyword: "theirs widgets", rankedBy: [{ domain: "b.com", position: 3 }, { domain: "c.com", position: 3 }] });
    expect(plan.cadence.firstTargets).toEqual(["mine widgets", "theirs widgets"]);
  });

  it("names no competitor below the overlap floor", async () => {
    const plan = await buildGrowthPlan("a.com", {
      ranked: async () => [kw("mine", 1, 10)],
      competitors: async () => [{ domain: "coincidence.com", sharedKeywords: 5, avgPosition: null, estimatedTraffic: null }],
      readiness: async (domain) => ({ domain, result: { domain, score: 100, findings: [] }, proposals: [], notes: [], artifacts: [] }),
    });
    expect(plan.competitors).toEqual([]);
    expect(plan.gaps).toEqual([]);
    expect(plan.layers.find((l) => l.id === "competitors")).toMatchObject({ ok: false });
  });
});
