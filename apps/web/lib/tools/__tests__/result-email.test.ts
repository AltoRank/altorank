import { describe, it, expect } from "vitest";
import { renderToolResultEmail, TOOL_RESULT_SLUGS } from "../result-email";

describe("renderToolResultEmail", () => {
  it("renders nothing for a slug with no renderer", () => {
    expect(renderToolResultEmail("anything-else", { url: "x" })).toBeNull();
    expect(renderToolResultEmail("", {})).toBeNull();
  });

  it("renders nothing when the context is not that tool's result", () => {
    expect(renderToolResultEmail("seo-health-checker", { keyword: "shoes" })).toBeNull();
    expect(renderToolResultEmail("seo-health-checker", undefined)).toBeNull();
    // Out of bounds: a score over 100, a 5000-character "keyword".
    expect(renderToolResultEmail("seo-health-checker", { url: "a.co", score: 101, errors: 0, warnings: 0, passes: 0 })).toBeNull();
    expect(renderToolResultEmail("serp-analyzer", { keyword: "k".repeat(5000), locale: "en", resultsAnalyzed: 1 })).toBeNull();
  });

  it("renders each known tool from its own data", () => {
    const cases: Record<(typeof TOOL_RESULT_SLUGS)[number], unknown> = {
      "seo-health-checker": { url: "https://a.co", score: 72, errors: 2, warnings: 3, passes: 10 },
      "content-brief-generator": { keyword: "shoes", title: "Best shoes", metaDescription: "desc", wordCountTarget: 1500 },
      "serp-analyzer": { keyword: "shoes", locale: "en-US", resultsAnalyzed: 10, avgWordCount: 1200, aiInsights: "insight" },
      "keyword-cluster-mapper": {
        seeds: ["shoes"],
        totalKeywords: 3,
        totalVolume: 12000,
        clusters: [{ name: "Running", suggestedPageType: "guide", keywords: ["a", "b"] }],
      },
      "meta-description-generator": { keyword: "shoes", variants: [{ style: "Direct", charCount: 120, text: "Buy shoes." }] },
      "keyword-gap-analyzer": { yourDomain: "a.co", competitors: ["b.co"], totalGapsFound: 42 },
    };
    for (const slug of TOOL_RESULT_SLUGS) {
      const r = renderToolResultEmail(slug, cases[slug]);
      expect(r, slug).not.toBeNull();
      expect(r!.subject.length, slug).toBeGreaterThan(0);
      expect(r!.html.length, slug).toBeGreaterThan(0);
    }
    expect(renderToolResultEmail("seo-health-checker", cases["seo-health-checker"])!.subject).toBe(
      "SEO Health Report: https://a.co",
    );
    expect(renderToolResultEmail("keyword-cluster-mapper", cases["keyword-cluster-mapper"])!.html).toContain("12.0K total volume");
  });

  /** Everything in the context is typed by a visitor; none of it may be markup. */
  it("escapes every string that lands in the body", () => {
    const evil = `<img src=x onerror="alert(1)">`;
    const r = renderToolResultEmail("meta-description-generator", {
      keyword: evil,
      variants: [{ style: evil, charCount: 1, text: evil }],
    })!;
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");

    const g = renderToolResultEmail("keyword-gap-analyzer", { yourDomain: evil, competitors: [evil], totalGapsFound: 1 })!;
    expect(g.html).not.toContain("<img");

    const c = renderToolResultEmail("keyword-cluster-mapper", {
      seeds: [evil],
      totalKeywords: 1,
      totalVolume: 1,
      clusters: [{ name: evil, suggestedPageType: evil, keywords: [evil] }],
    })!;
    expect(c.html).not.toContain("<img");
  });
});
