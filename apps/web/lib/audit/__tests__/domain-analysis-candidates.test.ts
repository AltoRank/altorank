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
const fit = vi.fn();
const sitemap = vi.fn();

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/keyword-research/discovery", () => ({ discoverBuyerKeywords: (...a: unknown[]) => discover(...a) }));
vi.mock("@/lib/keyword-research/buyer-fit", () => ({ judgeBuyerFit: (...a: unknown[]) => fit(...a) }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: null, traffic: null, referringDomains: null }) }));
vi.mock("@/lib/seo/site-crawl", () => ({ discoverUrls: (...a: unknown[]) => sitemap(...a) }));

const pages = vi.fn(() => [] as unknown[]);
vi.mock("../crawler", () => ({ crawlSite: async () => pages(), usablePages: (p: unknown[]) => p }));

vi.mock("@/lib/seo/ranked-keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/ranked-keywords")>("@/lib/seo/ranked-keywords");
  return { ...real, fetchRankedKeywords: (...a: unknown[]) => ranked(...a) };
});

import {
  analyseDomain,
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
/** What discovery returns for a site whose rivals and buyer seeds yield nothing. */
const nothingDiscovered = () => ({ fromCompetitors: [], fromIdeas: [], seeds: { seeds: [], basis: "none" as const }, seedsPriced: 0, competitorsAsked: [] });
const rivalsRank = (rows: unknown[]) => ({ ...nothingDiscovered(), fromCompetitors: rows, competitorsAsked: ["rival.co"] });

/** Just enough client for the keyword write path. */
function fakeSupabase(business: Record<string, unknown> | null = null) {
  const inserted: Array<Record<string, unknown>[]> = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          // `.eq(...)` is awaited for the keyword table and `.single()`d for the
          // workspace's business profile, so it has to be both.
          eq: () =>
            Object.assign(Promise.resolve({ data: [] }), {
              single: async () => ({ data: { business_profile: business } }),
            }),
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

const analyse = (
  extra: Record<string, unknown> = {},
  business: Record<string, unknown> | null = null,
) => {
  const { client, inserted } = fakeSupabase(business);
  return analyseDomain({ domain: "x.co", supabase: client, workspaceId: "ws1", ...extra }).then((a) => ({
    analysis: a,
    stored: inserted.flat(),
  }));
};

beforeEach(() => {
  for (const m of [ranked, discover, fit, sitemap]) m.mockReset();
  pages.mockReturnValue([]);
  ranked.mockResolvedValue([]);
  discover.mockResolvedValue(nothingDiscovered());
  fit.mockResolvedValue({ verdicts: new Map(), basis: "none" });
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

// ---------------------------------------------------------------------------
// The same rules through analyseDomain
// ---------------------------------------------------------------------------

describe("the stored hundred", () => {
  // A readable site, because these are about the reserve rule and not about
  // readability: since the spend gate, a site with no usable profile stores
  // nothing at all rather than storing rows it cannot judge.
  beforeEach(() => pages.mockReturnValue(newsletterSite()));

  // On-topic for that site, because relevance now judges these rows: the
  // shared `gapRow` is deliberately off-topic for the fallback tests below.
  // Built from the profile's own vocabulary, since one unknown token takes a
  // term's score to zero - which is the filter working, not a fixture quirk.
  const VOCAB = [
    "newsletter", "publishing", "deliverability", "subscriber", "analytics",
    "archive", "hosting", "growth", "guide", "pricing", "plans", "workflow",
  ];
  const topicalGapRow = (i: number) => {
    const a = VOCAB[i % VOCAB.length];
    const b = VOCAB[(Math.floor(i / VOCAB.length) + 1 + (i % VOCAB.length)) % VOCAB.length];
    return { ...gapRow(i), keyword: `${a} ${b}` };
  };

  // qasimcode.com, 2026-09-11. A studio selling fixed-price websites to
  // clinics and salons stored `wix`, `acuity`, `web sites` and four phrasings
  // of `free portfolio website` - every one of them arriving on the ranked
  // path, which was exempt from both the brand filter and the buyer test
  // because "a ranking is a test result". Its 1,606 write-ups are ABOUT those
  // tools; nobody who typed them was shopping for a $99/mo build.
  it("judges what the site ranks for, and drops a rival's name it ranks on", async () => {
    ranked.mockResolvedValue([
      { keyword: "wix", position: 80, url: "https://x.co/own/1", volume: 673000, difficulty: 68, cpc: 1, isBlogUrl: false },
      { keyword: "free portfolio website", position: 40, url: "https://x.co/own/2", volume: 165000, difficulty: 62, cpc: 1, isBlogUrl: false },
      { keyword: "newsletter deliverability", position: 12, url: "https://x.co/own/3", volume: 500, difficulty: 20, cpc: 1, isBlogUrl: false },
    ]);
    // The model keeps only the term this business's buyer would type. `wix`
    // never reaches it: the brand filter takes that one first.
    fit.mockResolvedValue({
      verdicts: new Map([
        ["free portfolio website", { keep: false }],
        ["newsletter deliverability", { keep: true }],
      ]),
      basis: "model",
    });
    const { stored } = await analyse({}, { competitors: ["wix.com"] });
    const terms = stored.map((r) => r.term);
    expect(terms).toContain("newsletter deliverability");
    expect(terms).not.toContain("wix");
    expect(terms).not.toContain("free portfolio website");
  });

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
    discover.mockResolvedValue(rivalsRank(Array.from({ length: 60 }, (_, i) => topicalGapRow(i))));
    const { analysis, stored } = await analyse();
    expect(analysis.keywordsFound).toBe(60);
    expect(stored.every((r) => r.source === "gap")).toBe(true);
  });

  it("a site that ranks for 200 things still gets its gap rows into the table", async () => {
    // This is F2: before the reserve, all 100 slots went to page-one rankings
    // and every gap and seed row the run had already paid for was thrown away.
    ranked.mockResolvedValue(Array.from({ length: 200 }, (_, i) => wonRow(i)));
    discover.mockResolvedValue(rivalsRank(Array.from({ length: 60 }, (_, i) => topicalGapRow(i))));
    const { stored } = await analyse();
    expect(stored).toHaveLength(100);
    expect(stored.filter((r) => r.source === "ranked")).toHaveLength(PAGE_ONE_RANKED_CAP);
    expect(stored.filter((r) => r.source === "gap")).toHaveLength(100 - PAGE_ONE_RANKED_CAP);
  });

  it("keeps striking-distance rankings out of the cap: those are the ones worth writing", async () => {
    // Position 11-20 is recommendKeywords' largest multiplier, not a term to
    // leave alone, so it is not what the reserve is protecting against.
    ranked.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ ...wonRow(i), position: 14 })));
    discover.mockResolvedValue(rivalsRank(Array.from({ length: 60 }, (_, i) => topicalGapRow(i))));
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

  it("drops nothing when the sitemap walk stopped at its own ceiling", async () => {
    // A prefix of a huge sitemap would read the site's own pages as somebody
    // else's. 5,000 is `discoverUrls`' cap, and hitting it means "there was
    // more", not "this is all of it".
    ranked.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ ...wonRow(i), url: `https://x.co/deep/${i}` })));
    sitemap.mockResolvedValue(Array.from({ length: 5000 }, (_, i) => `https://x.co/own/${i}`));
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

/**
 * A crawl that yields a topical profile able to judge relevance. Without one
 * the site is unreadable and the spend gate stores nothing at all.
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
