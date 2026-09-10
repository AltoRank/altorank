import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A site the product has just declared unreadable buys nothing.
 *
 * Measured on example.com, 2026-09-07 (R4-4-blank-flow.md, B1): phase 1 said
 * "Skipped reading your site — Too little readable text on the site to learn
 * from" and the run then stored 100 keywords ("ry domain", "explam",
 * "hotel best auto hogar barcelona"), planned 30 articles and wrote seven of
 * them, for $1.63.
 *
 * The cause was that both quality filters are disabled in exactly this case:
 * ranked rows were exempt from relevance because "the SERP already decided",
 * and with no profile `!usable` waved everything else through too. So the one
 * account with no basis for judging a keyword was the one account where
 * nothing was judged.
 */

const ranked = vi.fn();
const discover = vi.fn();
const difficulty = vi.fn();
const seeds = vi.fn();
const gap = vi.fn();
const insert = vi.fn();

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../crawler", () => ({ crawlSite: async () => [], usablePages: () => [] }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: null, traffic: null, referringDomains: null }) }));
vi.mock("@/lib/seo/keyword-gap", () => ({ fetchCompetitorGap: (...a: unknown[]) => gap(...a) }));
vi.mock("@/lib/seo/ranked-keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/ranked-keywords")>("@/lib/seo/ranked-keywords");
  return { ...real, fetchRankedKeywords: (...a: unknown[]) => ranked(...a) };
});
vi.mock("@/lib/seo/keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/keywords")>("@/lib/seo/keywords");
  return {
    ...real,
    discoverKeywords: (...a: unknown[]) => discover(...a),
    fetchKeywordDifficulty: (...a: unknown[]) => difficulty(...a),
    discoverKeywordsFromSeeds: (...a: unknown[]) => seeds(...a),
  };
});

import { analyseDomain } from "../domain-analysis";

/** example.com's actual ranked rows, which is what made this so cheap to miss. */
const junk = ["ry domain", "explam", "www example com minecraft", "fb history surf game"].map((keyword, i) => ({
  keyword,
  position: 3 + i,
  url: "https://example.com/",
  volume: 5_000,
  difficulty: 10,
  cpc: 0,
  isBlogUrl: false,
}));

/**
 * A Supabase double that records which table each insert went to, so "stored
 * no keywords" is checkable without also forbidding the `domain_audits` row
 * this function is supposed to write.
 */
function supabase() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          Object.assign(Promise.resolve({ data: [] }), {
            single: async () => ({ data: { business_profile: null } }),
          }),
      }),
      insert: (rows: unknown) => {
        insert(table, rows);
        return { select: async () => ({ data: [] }) };
      },
      update: () => ({ eq: async () => ({}) }),
    }),
  } as never;
}

const insertedTables = () => insert.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  for (const m of [ranked, discover, difficulty, seeds, gap, insert]) m.mockReset();
  ranked.mockResolvedValue(junk);
  discover.mockResolvedValue([]);
  seeds.mockResolvedValue([]);
  gap.mockResolvedValue([]);
  difficulty.mockResolvedValue(new Map());
});

describe("a site with no readable text", () => {
  it("stores no keywords, however well it ranks for nonsense", async () => {
    const a = await analyseDomain({ domain: "example.com", supabase: supabase(), workspaceId: "w" });
    expect(a.keywordsFound).toBe(0);
    expect(insertedTables()).not.toContain("keywords");
    expect(insertedTables()).not.toContain("keyword_rankings");
    // The audit row itself is still written: the analysis happened and its
    // result is "nothing could be judged", which is a finding, not a failure.
    expect(insertedTables()).toContain("domain_audits");
  });

  it("buys nothing else either: no gap, no seeded expansion, no ads fallback", async () => {
    // The three paid calls all sat downstream of a filter that ran after them.
    await analyseDomain({ domain: "example.com", supabase: supabase(), workspaceId: "w" });
    expect(gap).not.toHaveBeenCalled();
    expect(seeds).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(difficulty).not.toHaveBeenCalled();
  });

  it("says why, in words the run screen can quote", async () => {
    const a = await analyseDomain({ domain: "example.com" });
    const layer = a.layers.find((l) => l.id === "keywords");
    expect(layer?.status).toBe("unavailable");
    expect(layer?.detail).toContain("too little readable text");
    // Not "nothing rankable found": that is a claim about the market, and
    // this is a fact about the site.
    expect(layer?.detail).not.toMatch(/nothing rankable/i);
  });

  it("still returns the layers the workspace has already paid for", async () => {
    // Readiness, crawl, PageSpeed and authority all run: refusing the keyword
    // phase is not refusing the analysis.
    const a = await analyseDomain({ domain: "example.com" });
    expect(a.layers.map((l) => l.id)).toContain("readiness");
    expect(a.layers.map((l) => l.id)).toContain("authority");
  });
});
