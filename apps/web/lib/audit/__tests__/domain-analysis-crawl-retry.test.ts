import { describe, it, expect, vi, beforeEach } from "vitest";

/**
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
vi.mock("../agent-readiness", () => ({ runAgentReadiness: async () => ({ error: "not run in this test", score: 0, findings: [] }) }));
vi.mock("../crawler", async () => {
  const real = await vi.importActual<typeof import("../crawler")>("../crawler");
  return { ...real, crawlSite: (...a: unknown[]) => crawl(...a) };
});
vi.mock("../pagespeed", () => ({ fetchPageSpeedDetailed: async () => ({ ok: false, kind: "unavailable", detail: "test" }) }));
vi.mock("@/lib/cms/detect", () => ({ detectPlatform: async () => null }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => false }));
vi.mock("@/lib/seo/backlinks", () => ({ syncBacklinks: async () => ({ fetched: 0, total: null, lost: 0 }) }));
vi.mock("@/lib/seo/domain-metrics", () => ({ fetchDomainMetrics: async () => ({ authority: null, traffic: null, referringDomains: null }) }));

import { analyseDomain, isTransientCrawlFailure } from "../domain-analysis";

const dead = (error: string) => ({
  url: "https://packhub.io/", status: 0, title: "", metaDescription: "", h1: [], h2: [], images: [], links: [], loadTimeMs: 0, error,
});
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

const run = () => analyseDomain({ domain: "packhub.io", supabase: supabase(), workspaceId: "ws1", crawlRetryDelaysMs: [0, 0] });
const stamped = () => update.mock.calls.some(([t, p]) => t === "workspaces" && "first_analysed_at" in (p as object));
const crawlLayer = (a: Awaited<ReturnType<typeof analyseDomain>>) => a.layers.find((l) => l.id === "crawl")!;

beforeEach(() => {
  crawl.mockReset();
  update.mockReset();
});

describe("analyseDomain — a crawl that fails and then does not", () => {
  it("tries again and reads the site on the attempt that works", async () => {
    crawl.mockResolvedValueOnce([dead("timed out after 10s")]).mockResolvedValueOnce([dead("timed out after 10s")]).mockResolvedValueOnce([page]);
    const a = await run();
    expect(crawl).toHaveBeenCalledTimes(3);
    expect(crawlLayer(a).status).toBe("ok");
    expect(a.pagesCrawled).toBe(1);
  });

  it("stamps the look once it has actually happened", async () => {
    crawl.mockResolvedValueOnce([dead("timed out after 10s")]).mockResolvedValueOnce([page]);
    await run();
    expect(stamped()).toBe(true);
  });
});

describe("analyseDomain — a crawl that keeps failing for a transient reason", () => {
  beforeEach(() => crawl.mockResolvedValue([dead("timed out after 10s")]));

  it("gives up after the configured attempts, and says how many", async () => {
    const a = await run();
    expect(crawl).toHaveBeenCalledTimes(3);
    expect(crawlLayer(a).status).toBe("failed");
    expect(crawlLayer(a).detail).toContain("timed out after 10s");
    expect(crawlLayer(a).detail).toContain("3 attempts");
  });

  it("does not stamp first_analysed_at: nobody has looked yet", async () => {
    await run();
    expect(stamped()).toBe(false);
  });

  it("still writes the audit row, so the failure is on record", async () => {
    const a = await run();
    expect(a.pagesCrawled).toBe(0);
  });
});

describe("analyseDomain — a crawl that fails for a reason that will not change", () => {
  it("does not retry a host that does not resolve, and stamps it", async () => {
    crawl.mockResolvedValue([dead("host not found")]);
    await run();
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(stamped()).toBe(true);
  });

  it("does not retry an HTTP refusal", async () => {
    crawl.mockResolvedValue([{ ...page, status: 403 }]);
    await run();
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(stamped()).toBe(true);
  });
});

describe("isTransientCrawlFailure", () => {
  it.each(["timed out after 10s", "ECONNRESET", "socket hang up", "fetch failed", "EAI_AGAIN"])("%s clears on its own", (r) => {
    expect(isTransientCrawlFailure(r)).toBe(true);
  });
  it.each(["host not found", "TLS certificate could not be verified (CERT_HAS_EXPIRED)", "HTTP 403", "HTTP 500"])("%s does not", (r) => {
    expect(isTransientCrawlFailure(r)).toBe(false);
  });
  it("treats no reason as no grounds to retry", () => {
    expect(isTransientCrawlFailure(null)).toBe(false);
    expect(isTransientCrawlFailure("")).toBe(false);
  });
});
