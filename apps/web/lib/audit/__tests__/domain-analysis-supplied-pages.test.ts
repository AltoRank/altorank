import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Pages handed in stand in for the crawl: a Shopify store behind its password
 * page is read through the Admin API (lib/shopify/store-content.ts) and the
 * first look learns from that instead of from /password. (Harness copied
 * from domain-analysis-crawl-retry.test.ts.)
 *
 * Original note from that file:
 * One transient fetch failure must not become a permanent verdict.
 *
 * packhub.io, 2026-09-09 18:38:05: ten seconds after the wizard read the
 * homepage from the same function, the crawl got status 0 on every page. One
 * attempt, no retry, so: "too little readable text on the site", keywords and
 * plan skipped, `first_analysed_at` stamped - which is what cron/analyze
 * selects on, so the stamp was also the decision never to look again. A
 * profile refresh read eight pages eleven minutes later. The customer typed
 * keywords by hand.
 */

const crawl = vi.fn();
const update = vi.fn();

vi.mock("@/lib/e2e/stubs", () => ({ e2eStubsEnabled: () => false, stubAnalyseDomain: vi.fn() }));
vi.mock("../agent-readiness", () => ({ recordingFetcher: () => Object.assign(async () => ({ status: 0, headers: {}, body: "" }), { resources: new Map() }), runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../crawler", async () => {
  const real = await vi.importActual<typeof import("../crawler")>("../crawler");
  return { ...real, crawlSite: (...a: unknown[]) => crawl(...a) };
});
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => false }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: null, traffic: null, referringDomains: null }) }));

import { analyseDomain } from "../domain-analysis";

const page = {
  url: "https://packhub.io/", status: 200, loadTimeMs: 550, images: [], links: [],
  title: "PackHub - Scan-driven packout for fulfillment teams",
  metaDescription: "A smarter way to pack.",
  h1: ["Scan-driven packout for fulfillment teams"],
  h2: ["Connects directly to Shopify", "Cartonization and carrier rules", "Visual guidance at the packing station"],
};

function supabase() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => Object.assign(Promise.resolve({ data: [] }), { single: async () => ({ data: { business_profile: null } }) }),
      }),
      insert: () => ({ select: async () => ({ data: [] }) }),
      update: (patch: Record<string, unknown>) => {
        update(table, patch);
        return { eq: async () => ({}) };
      },
    }),
  } as never;
}

const crawlLayer = (a: Awaited<ReturnType<typeof analyseDomain>>) => a.layers.find((l) => l.id === "crawl")!;

beforeEach(() => {
  crawl.mockReset();
  update.mockReset();
});

const storePages = [
  { ...page, url: "https://fern.myshopify.com/", title: "Fern & Co", metaDescription: "Handmade ceramic planters and plant care.", h1: ["Fern & Co"], h2: [] },
  { ...page, url: "https://fern.myshopify.com/pages/about", title: "About our ceramic studio", metaDescription: "We throw every planter by hand in Bristol.", h1: ["About our ceramic studio"], h2: ["Glazes", "Drainage"] },
  { ...page, url: "https://fern.myshopify.com/blogs/news/repotting", title: "How to repot a fiddle leaf fig", metaDescription: "Repotting without shock.", h1: ["How to repot a fiddle leaf fig"], h2: ["Choosing a planter size"] },
];

describe("analyseDomain with pages supplied", () => {
  it("does not crawl, builds the profile from them, and audits nothing", async () => {
    const a = await analyseDomain({ domain: "fern.myshopify.com", supabase: supabase(), workspaceId: "ws1", pages: storePages as never });
    expect(crawl).not.toHaveBeenCalled();
    expect(crawlLayer(a)).toMatchObject({ status: "ok" });
    expect(crawlLayer(a).detail).toMatch(/read from the store itself/);
    expect(a.pagesCrawled).toBe(3);
    expect(a.topicalProfile?.terms).toBeTruthy();
    expect(Object.keys(a.topicalProfile!.terms)).toEqual(expect.arrayContaining(["ceramic"]));
  });

  it("crawls as before when none are supplied", async () => {
    crawl.mockResolvedValueOnce([page]);
    await analyseDomain({ domain: "packhub.io", supabase: supabase(), workspaceId: "ws1", crawlRetryDelaysMs: [0], rateBanWaitMs: 0 });
    expect(crawl).toHaveBeenCalledTimes(1);
  });
});
