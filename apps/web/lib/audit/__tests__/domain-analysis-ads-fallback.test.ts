import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The keywords_for_site fallback is the most expensive step of a first look
 * that can be skipped: $0.09 for the Google Ads call, then a keyword_overview
 * priced per term for the difficulty of up to 700 rows, of which at most
 * ADS_FALLBACK_CAP (40) are kept. Two rules are pinned here:
 *
 *   - no room, no call: with 40-49 candidates from the better sources the
 *     fallback used to buy both calls and keep nothing;
 *   - difficulty only for the rows that are kept, not for the 700 highest
 *     by volume.
 */

const ranked = vi.fn();
const discover = vi.fn();
const difficulty = vi.fn();
const seeds = vi.fn();

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../crawler", () => ({ crawlSite: async () => [], usablePages: () => [] }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/seo/keyword-gap", () => ({ fetchCompetitorGap: async () => [] }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: null, traffic: null, referringDomains: null }) }));
// A readable site. `crawlSite` is stubbed to nothing above, so without this
// the profile is empty and the whole keyword phase now stops before the
// fallback it exists to measure (see the unreadable-site guard in
// domain-analysis.ts). Relevance is pinned to 1 for the same reason: this file
// is about what the fallback buys, not about which terms survive scoring.
vi.mock("@/lib/seo/topical-profile", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/topical-profile")>("@/lib/seo/topical-profile");
  return {
    ...real,
    profileIsUsable: () => true,
    scoreRelevance: () => ({ score: 1, matched: [], unmatched: [], reason: "stubbed" }),
  };
});
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

import { analyseDomain, adsFallbackRoom } from "../domain-analysis";

const rankedRow = (i: number) => ({
  keyword: `ranked term ${i}`, position: 5 + i, url: `https://x.co/p${i}`, volume: 500, difficulty: 20, cpc: 1, isBlogUrl: false,
});
const adsRow = (i: number) => ({ keyword: `ads term ${i}`, volume: 1000 - i, difficulty: null, cpc: 0, competition: 0, intent: "info" as const });

beforeEach(() => {
  for (const m of [ranked, discover, difficulty, seeds]) m.mockReset();
  seeds.mockResolvedValue([]);
  difficulty.mockResolvedValue(new Map());
});

describe("adsFallbackRoom", () => {
  it("is the cap less what the better sources found, never negative", () => {
    expect(adsFallbackRoom(0)).toBe(40);
    expect(adsFallbackRoom(30)).toBe(10);
    expect(adsFallbackRoom(40)).toBe(0);
    expect(adsFallbackRoom(45)).toBe(0);
  });
});

describe("the keywords_for_site fallback", () => {
  it("is not called when the cap leaves no room, even below the thinness threshold", async () => {
    // 45 candidates: under the 50 that makes the list "thin", over the 40 cap.
    ranked.mockResolvedValue(Array.from({ length: 45 }, (_, i) => rankedRow(i)));
    const a = await analyseDomain({ domain: "x.co" });
    expect(discover).not.toHaveBeenCalled();
    expect(difficulty).not.toHaveBeenCalled();
    expect(a.keywordsFound).toBe(45);
  });

  it("looks up difficulty only for the rows it keeps", async () => {
    ranked.mockResolvedValue(Array.from({ length: 10 }, (_, i) => rankedRow(i)));
    discover.mockResolvedValue(Array.from({ length: 200 }, (_, i) => adsRow(i)));
    difficulty.mockResolvedValue(new Map([["ads term 0", 33]]));

    const a = await analyseDomain({ domain: "x.co" });

    expect(discover).toHaveBeenCalledOnce();
    // The old call asked discovery for difficulty itself, across 700 terms.
    expect(discover.mock.calls[0][1]).toBeUndefined();
    expect(difficulty).toHaveBeenCalledOnce();
    const asked = difficulty.mock.calls[0][0] as string[];
    expect(asked).toHaveLength(30);
    expect(asked[0]).toBe("ads term 0");
    // 10 ranked + 30 from the fallback, and the looked-up difficulty landed.
    expect(a.keywordsFound).toBe(40);
    expect(a.layers.find((l) => l.id === "keywords")?.detail).toContain("the rest from the ads keyword tool");
  });

  it("does not run the fallback on a quick look", async () => {
    ranked.mockResolvedValue([rankedRow(1)]);
    await analyseDomain({ domain: "x.co", depth: "quick" });
    expect(discover).not.toHaveBeenCalled();
  });
});
