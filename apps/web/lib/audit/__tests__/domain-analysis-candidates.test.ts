import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Which hundred keywords a new workspace gets, and what was paid for them.
 *
 * Two measured failures are pinned here.
 *
 * F2 (round4 R4-2): candidates are collected ranked -> gap -> seeds and the
 * first MAX_KEYWORDS_STORED are kept. buttondown.com ranks for 500+ terms, so
 * all 100 stored rows were page-one rankings, `recommendKeywords` marked every
 * one "already ranking at position N, leave it alone", `pickNextKeyword` found
 * nothing and the run ended "Nothing scheduled yet" - after paying for the gap
 * and seed calls whose rows never reached the table. Worse, the rankings were
 * its TENANTS' newsletters ("bald nba players"), which the ranked exemption
 * treats as on-topic.
 *
 * W1 (round4 §4): the ads fallback bought 100 rows for $0.0900 plus $0.0146 of
 * difficulty and then had all 100 dropped by a relevance filter that ran after
 * both calls.
 */

const ranked = vi.fn();
const discover = vi.fn();
const difficulty = vi.fn();
const seeds = vi.fn();
const gap = vi.fn();
const sitemap = vi.fn();

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/seo/keyword-gap", () => ({ fetchCompetitorGap: (...a: unknown[]) => gap(...a) }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: null, traffic: null, referringDomains: null }) }));
vi.mock("@/lib/seo/site-crawl", () => ({ discoverUrls: (...a: unknown[]) => sitemap(...a) }));

const pages = vi.fn(() => [] as unknown[]);
vi.mock("../crawler", () => ({ crawlSite: async () => pages(), usablePages: (p: unknown[]) => p }));

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

import {
  analyseDomain,
  adsFallbackWorthCalling,
  ownPagePaths,
  rankedOnOwnPages,
  takeReservingSlots,
  PAGE_ONE_RANKED_CAP,
  SITEMAP_TRUST_MIN,
} from "../domain-analysis";
import type { RankedKeyword } from "@/lib/seo/ranked-keywords";

/**
 * A ranking the site already holds on page one: nothing left to win.
 *
 * Indices start at 1000 because `assessKeywordQuality` rejects a term with a
 * single-character word in it, and "won term 3" is one.
 */
const wonRow = (i: number, url = `https://x.co/own/${1000 + i}`): RankedKeyword => ({
  keyword: `won term ${1000 + i}`, position: 1 + (i % 10), url, volume: 500, difficulty: 20, cpc: 1, isBlogUrl: false,
});
/** A term a competitor holds and this site does not: rank 1, still writable. */
const gapRow = (i: number) => ({
  keyword: `gap term ${1000 + i}`, volume: 900 - i, difficulty: null, cpc: 0, intent: "info" as const, competitor: "rival.co",
});
const adsRow = (keyword: string, volume = 1000) => ({
  keyword, volume, difficulty: null, cpc: 0, competition: 0, intent: "info" as const,
});

/** Just enough client for the keyword write path. */
function fakeSupabase() {
  const inserted: Array<Record<string, unknown>[]> = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: async () => ({ data: [] }),
        }),
        insert(rows: Record<string, unknown>[]) {
          if (table === "keywords") inserted.push(rows);
          return {
            select: async () => ({ data: rows.map((r, i) => ({ id: `k${i}`, term: r.term })) }),
            then: (res: (v: { data: null }) => unknown) => res({ data: null }),
          };
        },
        update: () => ({ eq: async () => ({ data: null }) }),
        upsert: async () => ({ data: null }),
      };
    },
  };
  return { client: client as never, inserted };
}

const analyse = (extra: Record<string, unknown> = {}) => {
  const { client, inserted } = fakeSupabase();
  return analyseDomain({ domain: "x.co", supabase: client, workspaceId: "ws1", ...extra }).then((a) => ({
    analysis: a,
    stored: inserted.flat(),
  }));
};

beforeEach(() => {
  for (const m of [ranked, discover, difficulty, seeds, gap, sitemap]) m.mockReset();
  pages.mockReturnValue([]);
  ranked.mockResolvedValue([]);
  seeds.mockResolvedValue([]);
  gap.mockResolvedValue([]);
  discover.mockResolvedValue([]);
  difficulty.mockResolvedValue(new Map());
  sitemap.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// The rules, on their own
// ---------------------------------------------------------------------------

describe("takeReservingSlots", () => {
  it("keeps half the list for rows that can still be written to", () => {
    const rows = [
      ...Array.from({ length: 200 }, (_, i) => ({ won: true, id: `won${i}` })),
      ...Array.from({ length: 200 }, (_, i) => ({ won: false, id: `open${i}` })),
    ];
    const top = takeReservingSlots(rows, 100, (r) => r.won);
    expect(top).toHaveLength(100);
    expect(top.filter((r) => r.won)).toHaveLength(PAGE_ONE_RANKED_CAP);
    expect(top.filter((r) => !r.won)).toHaveLength(100 - PAGE_ONE_RANKED_CAP);
  });

  it("defers the surplus rather than dropping it: a site that ranks for everything still fills the list", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ won: true, id: `won${i}` }));
    const top = takeReservingSlots(rows, 100, (r) => r.won);
    expect(top).toHaveLength(100);
    // Order is preserved inside each group: the first 50 by the caller's sort,
    // then the deferred surplus in the same order.
    expect(top[0].id).toBe("won0");
    expect(top[PAGE_ONE_RANKED_CAP].id).toBe(`won${PAGE_ONE_RANKED_CAP}`);
  });

  it("does nothing at all when nothing is already won", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ won: false, id: `open${i}` }));
    expect(takeReservingSlots(rows, 100, (r) => r.won)).toHaveLength(30);
  });
});

describe("ownPagePaths", () => {
  it("refuses to answer from a sitemap too small to be evidence", () => {
    expect(ownPagePaths(Array.from({ length: SITEMAP_TRUST_MIN }, (_, i) => `https://x.co/p${i}`))).toBeNull();
    expect(ownPagePaths([])).toBeNull();
  });

  it("normalises to paths, ignoring host, scheme, case and trailing slash", () => {
    const urls = Array.from({ length: SITEMAP_TRUST_MIN + 1 }, (_, i) => `https://www.x.co/Blog/P${i}/`);
    const paths = ownPagePaths(urls)!;
    expect(paths.has("/blog/p0")).toBe(true);
    expect(paths.size).toBe(SITEMAP_TRUST_MIN + 1);
  });
});

describe("rankedOnOwnPages", () => {
  const listed = ownPagePaths(Array.from({ length: SITEMAP_TRUST_MIN + 1 }, (_, i) => `https://x.co/own/${1000 + i}`))!;

  it("drops a ranking earned by a page the site does not list", () => {
    const rows = [wonRow(1), { ...wonRow(2), url: "https://x.co/tenant/bald-nba-players" }];
    expect(rankedOnOwnPages(rows, listed).map((k) => k.url)).toEqual(["https://x.co/own/1001"]);
  });

  it("keeps a row it cannot judge, and every row when there is no sitemap to judge with", () => {
    const noUrl = { ...wonRow(3), url: null };
    expect(rankedOnOwnPages([noUrl], listed)).toHaveLength(1);
    const foreign = { ...wonRow(4), url: "https://x.co/tenant/x" };
    expect(rankedOnOwnPages([foreign], null)).toHaveLength(1);
  });
});

describe("adsFallbackWorthCalling", () => {
  it("calls when this run has too few judged rows to have learned anything", () => {
    expect(adsFallbackWorthCalling({ judged: 0, kept: 0 })).toBe(true);
    expect(adsFallbackWorthCalling({ judged: 4, kept: 0 })).toBe(true);
  });

  it("refuses when the same filter has already rejected every provider row this run", () => {
    expect(adsFallbackWorthCalling({ judged: 20, kept: 0 })).toBe(false);
  });

  it("calls when the filter kept anything at all", () => {
    expect(adsFallbackWorthCalling({ judged: 20, kept: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The same rules through analyseDomain
// ---------------------------------------------------------------------------

describe("the stored hundred", () => {
  it("a site that ranks for everything still stores a hundred, all of them rankings", async () => {
    // The headline number a customer is shown must not move for this site.
    ranked.mockResolvedValue(Array.from({ length: 200 }, (_, i) => wonRow(i)));
    const { analysis, stored } = await analyse();
    expect(analysis.keywordsFound).toBe(100);
    expect(stored).toHaveLength(100);
    expect(stored.every((r) => r.source === "ranked")).toBe(true);
  });

  it("a site that ranks for nothing is untouched by the reserve", async () => {
    ranked.mockResolvedValue([]);
    gap.mockResolvedValue(Array.from({ length: 60 }, (_, i) => gapRow(i)));
    const { analysis, stored } = await analyse();
    expect(analysis.keywordsFound).toBe(60);
    expect(stored.every((r) => r.source === "gap")).toBe(true);
  });

  it("a site that ranks for 200 things still gets its gap rows into the table", async () => {
    // This is F2: before the reserve, all 100 slots went to page-one rankings
    // and every gap and seed row the run had already paid for was thrown away.
    ranked.mockResolvedValue(Array.from({ length: 200 }, (_, i) => wonRow(i)));
    gap.mockResolvedValue(Array.from({ length: 60 }, (_, i) => gapRow(i)));
    const { stored } = await analyse();
    expect(stored).toHaveLength(100);
    expect(stored.filter((r) => r.source === "ranked")).toHaveLength(PAGE_ONE_RANKED_CAP);
    expect(stored.filter((r) => r.source === "gap")).toHaveLength(100 - PAGE_ONE_RANKED_CAP);
  });

  it("keeps striking-distance rankings out of the cap: those are the ones worth writing", async () => {
    // Position 11-20 is recommendKeywords' largest multiplier, not a term to
    // leave alone, so it is not what the reserve is protecting against.
    ranked.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ ...wonRow(i), position: 14 })));
    gap.mockResolvedValue(Array.from({ length: 60 }, (_, i) => gapRow(i)));
    const { stored } = await analyse();
    expect(stored.filter((r) => r.source === "ranked")).toHaveLength(100);
  });

  it("leaves rankings on pages the sitemap does not list out of the queue, and says so", async () => {
    // buttondown.com's shape: half the rankings belong to its subscribers.
    ranked.mockResolvedValue([
      ...Array.from({ length: 20 }, (_, i) => wonRow(i)),
      ...Array.from({ length: 20 }, (_, i) => ({ ...wonRow(100 + i), url: `https://x.co/tenant/${i}` })),
    ]);
    sitemap.mockResolvedValue(Array.from({ length: SITEMAP_TRUST_MIN + 1 }, (_, i) => `https://x.co/own/${1000 + i}`));
    const { analysis, stored } = await analyse();
    expect(stored).toHaveLength(20);
    expect(stored.every((r) => (r.term as string).startsWith("won term 10"))).toBe(true);
    // The headline stays true: those pages do rank on this domain.
    expect(analysis.rankedKeywords).toHaveLength(40);
    expect(analysis.layers.find((l) => l.id === "keywords")?.detail).toContain(
      "20 rankings on pages the sitemap does not list, left out",
    );
  });

  it("drops nothing when the sitemap is too small to be evidence", async () => {
    ranked.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ ...wonRow(i), url: `https://x.co/tenant/${i}` })));
    sitemap.mockResolvedValue(Array.from({ length: 10 }, (_, i) => `https://x.co/own/${i}`));
    const { stored } = await analyse();
    expect(stored).toHaveLength(20);
  });

  it("does not walk the sitemap on a quick look, or when nothing ranks", async () => {
    ranked.mockResolvedValue([wonRow(1)]);
    await analyseDomain({ domain: "x.co", depth: "quick" });
    expect(sitemap).not.toHaveBeenCalled();
    ranked.mockResolvedValue([]);
    await analyse();
    expect(sitemap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W1: what the ads fallback pays for
// ---------------------------------------------------------------------------

/**
 * A crawl that yields a topical profile able to judge relevance. Without one,
 * `scoreRelevance` returns 1 for everything and the filter below cannot bite -
 * which is also why the thin sites this fallback exists for are the ones it
 * wasted the most money on.
 */
function newsletterSite() {
  const page = (url: string, title: string, h1: string, h2: string[]) => ({
    url, status: 200, title, metaDescription: "", h1: [h1], h2, images: [], links: [], loadTimeMs: 10,
  });
  return [
    page("https://x.co/", "Newsletter publishing for writers", "Newsletter publishing for writers", ["Deliverability", "Subscriber analytics"]),
    page("https://x.co/pricing", "Newsletter pricing", "Publishing plans", ["Deliverability", "Archive hosting"]),
    page("https://x.co/blog", "Writing a newsletter", "Subscriber growth", ["Archive hosting", "Publishing workflow"]),
    page("https://x.co/docs", "Publishing workflow", "Deliverability guide", ["Subscriber analytics", "Publishing workflow"]),
  ];
}

describe("the ads fallback", () => {
  it("pays for difficulty only on the rows relevance can keep", async () => {
    pages.mockReturnValue(newsletterSite());
    ranked.mockResolvedValue([]);
    discover.mockResolvedValue([
      adsRow("newsletter publishing tools"),
      adsRow("bald nba players", 90000),
      adsRow("online casinos switzerland", 80000),
      adsRow("subscriber analytics"),
    ]);

    const { stored } = await analyse();

    expect(discover).toHaveBeenCalledOnce();
    // Before this the filter ran after both calls: difficulty was bought for
    // all four, and then all four were scored and the junk dropped.
    const asked = difficulty.mock.calls[0]?.[0] as string[] | undefined;
    expect(asked).toBeDefined();
    expect(asked).not.toContain("bald nba players");
    expect(stored.map((r) => r.term)).not.toContain("online casinos switzerland");
  });

  it("does not buy difficulty at all when nothing the ads call returned can be stored", async () => {
    pages.mockReturnValue(newsletterSite());
    ranked.mockResolvedValue([]);
    discover.mockResolvedValue([adsRow("bald nba players", 90000), adsRow("online casinos switzerland", 80000)]);
    const { stored } = await analyse();
    expect(discover).toHaveBeenCalledOnce();
    expect(difficulty).not.toHaveBeenCalled();
    expect(stored).toHaveLength(0);
  });

  it("does not make the call at all once the same filter has rejected every provider row this run", async () => {
    pages.mockReturnValue(newsletterSite());
    ranked.mockResolvedValue([]);
    // Twenty competitor-gap rows, none of which the profile accepts. The ads
    // list is a domain-level guess and is not going to do better.
    gap.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ ...gapRow(i), keyword: `unrelated casino topic ${1000 + i}` })),
    );
    await analyse();
    expect(discover).not.toHaveBeenCalled();
    expect(difficulty).not.toHaveBeenCalled();
  });
});
