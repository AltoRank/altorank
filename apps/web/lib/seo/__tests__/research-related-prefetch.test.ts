import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A draft handed its related keywords must not buy them again.
 *
 * The onboarding fan-out buys the whole week in one `keywords_for_keywords`
 * task - the endpoint is billed per task and takes twenty seeds - and hands
 * each draft its share. If `gatherArticleResearch` bought its own anyway the
 * run would pay $0.63 plus $0.09, which is worse than the $0.63 it started
 * with (round4 §4, W2).
 */

const { serp, related } = vi.hoisted(() => ({ serp: vi.fn(), related: vi.fn() }));
vi.mock("../brief-data", () => ({
  fetchAdvancedSerp: (...a: unknown[]) => serp(...a),
  fetchRelatedKeywords: (...a: unknown[]) => related(...a),
}));
vi.mock("../client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/audit/lenient-fetch", () => ({ fetchSite: async () => ({ ok: false, status: 0, body: "" }) }));

const { gatherArticleResearch } = await import("../research");

const PREFETCHED = [{ keyword: "seo agents", searchVolume: 100, competition: null }];

beforeEach(() => {
  serp.mockReset();
  related.mockReset();
  serp.mockResolvedValue({ organic: [], peopleAlsoAsk: [], aiOverview: null });
  related.mockResolvedValue([]);
});

describe("gatherArticleResearch related keywords", () => {
  it("uses the workspace market for both providers instead of the language default", async () => {
    await gatherArticleResearch({ keyword: "practice website", locale: "en", locationCode: 2826 });
    expect(serp).toHaveBeenCalledWith("practice website", { languageCode: "en", locationCode: 2826 });
    expect(related).toHaveBeenCalledWith("practice website", { languageCode: "en", locationCode: 2826 });
  });
  it("uses the rows it was handed and does not call the provider", async () => {
    const research = await gatherArticleResearch({ keyword: "seo agent", relatedKeywords: PREFETCHED });
    expect(related).not.toHaveBeenCalled();
    expect(research.relatedKeywords).toEqual(PREFETCHED);
    expect(research.layers.find((l) => l.id === "related_keywords")).toMatchObject({
      status: "ok",
      detail: "1 related keywords, from this run's shared lookup",
    });
  });

  it("treats an empty share as an answer, not as an absence", async () => {
    // Measured: one seed came back with zero rows for its own $0.09. Re-buying
    // it here would undo the saving the batch exists for.
    const research = await gatherArticleResearch({ keyword: "fairnote", relatedKeywords: [] });
    expect(related).not.toHaveBeenCalled();
    expect(research.relatedKeywords).toEqual([]);
  });

  it("still buys its own when nobody looked", async () => {
    related.mockResolvedValue(PREFETCHED);
    const research = await gatherArticleResearch({ keyword: "seo agent" });
    expect(related).toHaveBeenCalledOnce();
    expect(research.relatedKeywords).toEqual(PREFETCHED);
    expect(research.layers.find((l) => l.id === "related_keywords")?.detail).toBe("1 related keywords");
  });
});
