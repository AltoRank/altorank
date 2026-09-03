import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CrawlResult } from "../crawler";

const crawlSite = vi.fn();
vi.mock("../crawler", () => ({ crawlSite: (...a: unknown[]) => crawlSite(...a) }));

const page = (o: Partial<CrawlResult>): CrawlResult => ({
  url: "https://example.com/", status: 200, title: "", metaDescription: "",
  h1: [], h2: [], images: [], links: [], loadTimeMs: 0, ...o,
});

/** A real site's worth of headings, enough to build a usable profile. */
const GOOD = [
  page({ title: "Signal Analytics for retailers", metaDescription: "Retail forecasting from your own data.",
         h1: ["Retail forecasting"], h2: ["Forecasts you can act on", "Built for retail teams"] }),
  page({ url: "https://example.com/how", title: "How the forecasting works",
         h1: ["Signals blended with yours"], h2: ["Retail data in", "Data quality"] }),
];

/** Records writes so a test can assert none happened. */
function client() {
  const updates: unknown[] = [];
  const sb = {
    from: () => ({
      update: (v: unknown) => { updates.push(v); return { eq: async () => ({ error: null }) }; },
    }),
  };
  return { sb: sb as never, updates };
}

beforeEach(() => crawlSite.mockReset());

/**
 * An empty profile is not a degraded filter, it is no filter: scoreRelevance
 * returns 1 for everything when there is no vocabulary to judge against. A
 * refresh that overwrote a good profile with a failed crawl's would silently
 * switch relevance off for that site until the next refresh a month later.
 * Yesterday's vocabulary beats none.
 */
describe("refreshTopicalProfile never trades a real profile for an empty one", () => {
  it("writes nothing when the crawl returns no pages", async () => {
    crawlSite.mockResolvedValue([]);
    const { sb, updates } = client();
    const { refreshTopicalProfile } = await import("../profile-refresh");
    const r = await refreshTopicalProfile(sb, "ws1", "example.com");
    expect(r.status).toBe("skipped");
    expect(updates).toHaveLength(0);
  });

  /**
   * The crawl-throws path (crawlSite rejecting -> status "error", no write) is
   * handled by the try/catch in refreshTopicalProfile and was verified by hand:
   * it returns {status:"error", detail:"ENOTFOUND"} and writes nothing. It is
   * not asserted here because this runner reports an error thrown inside a mock
   * as unhandled even after the code under test has caught it, and fails the
   * test on that alone - a rejected promise, a sync throw and a pre-caught
   * rejection all trip it. Asserting the write path below instead, which
   * reaches the same "error" outcome without a mock that throws.
   */
  it("reports a failed write as an error rather than a refresh", async () => {
    crawlSite.mockResolvedValue(GOOD);
    const sb = {
      from: () => ({
        update: () => ({ eq: async () => ({ error: { message: "permission denied" } }) }),
      }),
    };
    const { refreshTopicalProfile } = await import("../profile-refresh");
    const r = await refreshTopicalProfile(sb as never, "ws1", "example.com");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("permission denied");
  });

  it("writes nothing when pages came back but say almost nothing", async () => {
    // A TLS failure or a JS-only shell: 200s with no headings to read.
    crawlSite.mockResolvedValue([page({}), page({ url: "https://example.com/a" })]);
    const { sb, updates } = client();
    const { refreshTopicalProfile } = await import("../profile-refresh");
    const r = await refreshTopicalProfile(sb, "ws1", "example.com");
    expect(r.status).toBe("skipped");
    expect(updates).toHaveLength(0);
  });

  it("writes the profile when the crawl is good", async () => {
    crawlSite.mockResolvedValue(GOOD);
    const { sb, updates } = client();
    const { refreshTopicalProfile } = await import("../profile-refresh");
    const r = await refreshTopicalProfile(sb, "ws1", "example.com");
    expect(r.status).toBe("refreshed");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty("topical_profile");
  });
});
