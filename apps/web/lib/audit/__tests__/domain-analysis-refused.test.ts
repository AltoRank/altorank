import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A site that refuses the crawl, through `analyseDomain`.
 *
 * A signup, 2026-10-21: a Shopify store behind its own Cloudflare
 * challenge answered 403 to every agent. The wizard had described it and
 * DataForSEO knew its rankings, but with no page text the keyword phase
 * stored nothing and the run ended with no plan and no draft.
 *
 * The fallback judges the ranked terms against the wizard's description
 * instead - only on a refusal, and only when the domain ranks, so the
 * example.com case (domain-analysis-unreadable.test.ts) stays shut.
 */

const ranked = vi.fn();
const discover = vi.fn();
const fit = vi.fn();
const pages = vi.fn(() => [] as unknown[]);

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../crawler", () => ({ crawlSite: async () => pages(), usablePages: (p: Array<{ status: number }>) => p.filter((x) => x.status >= 200 && x.status < 400) }));
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: 29, traffic: null, referringDomains: null }) }));
vi.mock("@/lib/seo/site-crawl", () => ({ discoverUrls: async () => [], recordLinkedPages: async () => ({ inserted: 0, updated: 0 }) }));
vi.mock("@/lib/keyword-research/discovery", () => ({ discoverBuyerKeywords: (...a: unknown[]) => discover(...a) }));
vi.mock("@/lib/keyword-research/buyer-fit", () => ({ judgeBuyerFit: (...a: unknown[]) => fit(...a) }));
vi.mock("@/lib/seo/ranked-keywords", async () => {
  const real = await vi.importActual<typeof import("@/lib/seo/ranked-keywords")>("@/lib/seo/ranked-keywords");
  return { ...real, fetchRankedKeywords: (...a: unknown[]) => ranked(...a) };
});

import { analyseDomain } from "../domain-analysis";

/** The kind of profile the wizard writes without reading a page. */
const TUBBY_TODD = {
  name: "Baby Bath Co",
  description:
    "Baby Bath Co makes gentle, plant-based skin and hair care products designed for sensitive, eczema-prone baby and family skin.",
  audiences: ["Parents of babies with sensitive skin", "Parents of children with eczema"],
  offerings: ["Baby skin care products", "Baby hair care products", "Eczema-friendly moisturizers", "All Over Ointment", "Gift sets"],
  buyingJobs: ["Soothe sensitive and eczema-prone baby skin", "Build a complete baby skincare routine"],
  competitors: ["rival.example"],
};

const rankedRows = ["baby eczema cream", "baby lotion for sensitive skin", "all over ointment"].map((keyword, i) => ({
  keyword,
  position: 4 + i,
  url: "https://babybath.example/products/x",
  volume: 2_000,
  difficulty: 20,
  cpc: 1,
  isBlogUrl: false,
}));

const refused = (url: string) => ({ url, status: 403, title: "", metaDescription: "", h1: [], h2: [], images: [], links: [], loadTimeMs: 10 });

function fakeSupabase(business: unknown) {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => Object.assign(Promise.resolve({ data: [] }), { single: async () => ({ data: { business_profile: business } }) }),
        }),
        insert(rows: Record<string, unknown>[] | Record<string, unknown>) {
          if (table === "keywords") inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          const list = Array.isArray(rows) ? rows : [rows];
          return {
            select: async () => ({ data: list.map((r, i) => ({ id: `k${i}`, term: r.term })) }),
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

const analyse = (business: unknown = TUBBY_TODD) => {
  const { client, inserted } = fakeSupabase(business);
  return analyseDomain({ domain: "babybath.example", supabase: client, workspaceId: "ws1", crawlRetryDelaysMs: [0, 0], rateBanWaitMs: 0 }).then((a) => ({ analysis: a, stored: inserted }));
};

beforeEach(() => {
  for (const m of [ranked, discover, fit, pages]) m.mockReset();
  pages.mockReturnValue([refused("https://babybath.example/")]);
  ranked.mockResolvedValue(rankedRows);
  discover.mockResolvedValue({ fromCompetitors: [], fromIdeas: [], seeds: { seeds: [], basis: "none" }, seedsPriced: 0, competitorsAsked: [] });
  fit.mockImplementation(async (_b: unknown, terms: string[]) => ({ basis: "model", verdicts: new Map(terms.map((t) => [t, { keep: true, reason: null }])) }));
});

describe("a site that refuses the crawl", () => {
  it("judges its rankings against the business profile and stores them", async () => {
    const { analysis, stored } = await analyse();
    expect(analysis.layers.find((l) => l.id === "crawl")?.status).toBe("failed");
    expect(fit).toHaveBeenCalled();
    expect(analysis.keywordsFound).toBeGreaterThan(0);
    expect(stored.map((r) => r.term)).toContain("baby eczema cream");
  });

  it("settles the first look, so the nightly retries do not buy discovery again", async () => {
    const { analysis } = await analyse();
    expect(analysis.firstLook).toEqual({ attempts: 1, settled: true, reason: "profile" });
  });

  it("keeps retrying when the fallback stored nothing", async () => {
    fit.mockImplementation(async (_b: unknown, terms: string[]) => ({ basis: "model", verdicts: new Map(terms.map((t) => [t, { keep: false, reason: "no" }])) }));
    discover.mockResolvedValue({ fromCompetitors: [], fromIdeas: [], seeds: { seeds: [], basis: "none" }, seedsPriced: 0, competitorsAsked: [] });
    ranked.mockResolvedValue([]);
    const { analysis } = await analyse();
    expect(analysis.firstLook?.reason).not.toBe("profile");
  });

  it("still runs every term through the buyer test", async () => {
    fit.mockImplementation(async (_b: unknown, terms: string[]) => ({
      basis: "model",
      verdicts: new Map(terms.map((t) => [t, t === "all over ointment" ? { keep: false, reason: "not a buyer search" } : { keep: true, reason: null }])),
    }));
    const { stored } = await analyse();
    const queued = stored.filter((r) => r.status === "new").map((r) => r.term);
    expect(queued).not.toContain("all over ointment");
    expect(queued).toContain("baby eczema cream");
  });

  it("stores nothing when the wizard learned nothing about the business", async () => {
    const { analysis, stored } = await analyse(null);
    expect(analysis.keywordsFound).toBe(0);
    expect(stored).toHaveLength(0);
    expect(fit).not.toHaveBeenCalled();
  });

  it("stores nothing when the domain ranks for nothing", async () => {
    ranked.mockResolvedValue([]);
    const { analysis } = await analyse();
    expect(analysis.layers.find((l) => l.id === "keywords")?.detail).toContain("too little readable text");
    expect(fit).not.toHaveBeenCalled();
  });

  it("does not apply to a site that answered with too little text", async () => {
    pages.mockReturnValue([{ ...refused("https://babybath.example/"), status: 404 }]);
    const { analysis } = await analyse();
    expect(analysis.keywordsFound).toBe(0);
    expect(fit).not.toHaveBeenCalled();
  });
});
