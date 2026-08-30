import { describe, it, expect } from "vitest";
import { factCheckArticle } from "../fact-check";
import type { ArticleResearch } from "@/lib/seo/research";

const research = (competitors: Array<{ title: string; description: string; domain: string }>): ArticleResearch => ({
  keyword: "widget",
  language: "English",
  intent: { intent: "info", confidence: "low", signals: [], lexicon: true },
  competitors: competitors.map((c) => ({ ...c, url: `https://${c.domain}`, wordCount: null })),
  peopleAlsoAsk: [],
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1500,
  wordCountBasis: "test",
  layers: [],
});

describe("factCheckArticle — flagging unsourced figures", () => {
  it("flags a bare percentage as unsourced and high severity", () => {
    const r = factCheckArticle("<p>Around 73% of sites fail this check.</p>");
    expect(r.verdict).toBe("high_risk");
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({
      kind: "statistic",
      status: "unsourced",
      severity: "high",
      text: "73%",
    });
  });

  it("flags an appeal to research with no named study", () => {
    const r = factCheckArticle("<p>Research shows this approach works better.</p>");
    expect(r.claims[0].kind).toBe("research_reference");
    expect(r.claims[0].status).toBe("unsourced");
  });

  it("does not flag a possessive reference to the reader's own data", () => {
    // Caught on a real generation: "Fix the cause your data shows first" is
    // not an appeal to an unnamed study, and flagging it trains people to
    // ignore the checker.
    const r = factCheckArticle("<p>Fix the cause your data shows first, then layer in emails.</p>");
    expect(r.verdict).toBe("clean");
  });

  it("still flags the same phrasing without a possessive", () => {
    const r = factCheckArticle("<p>Fix the cause the data shows first.</p>");
    expect(r.claims[0].kind).toBe("research_reference");
  });

  it("flags money and multiplier claims", () => {
    const r = factCheckArticle("<p>Teams save €4,500 and ship 3x faster.</p>");
    const kinds = r.claims.map((c) => c.kind);
    expect(kinds).toContain("money");
    expect(kinds).toContain("multiplier");
  });

  it("downgrades a figure that names its source", () => {
    const r = factCheckArticle(
      "<p>According to the HTTP Archive, 42% of pages ship unused CSS.</p>",
    );
    const stat = r.claims.find((c) => c.kind === "statistic")!;
    expect(stat.status).toBe("needs_verification");
    expect(stat.severity).toBe("medium");
    expect(stat.attribution).toContain("HTTP Archive");
    expect(r.verdict).toBe("review");
  });

  it("downgrades a figure whose paragraph carries an external citation link", () => {
    const r = factCheckArticle(
      '<p>Roughly 58% of teams do this. <a href="https://example.org/study">Source</a></p>',
    );
    expect(r.claims[0].status).toBe("needs_verification");
  });

  it("does not treat an internal link as a citation", () => {
    const r = factCheckArticle('<p>Roughly 58% of teams do this. <a href="/blog/x">More</a></p>');
    expect(r.claims[0].status).toBe("unsourced");
    expect(r.claims[0].severity).toBe("high");
  });

  it("returns a clean verdict for prose with no checkable claims", () => {
    const r = factCheckArticle(
      "<h2>Getting started</h2><p>Most teams find the first step is the hardest. " +
        "Start small and expand once it works.</p>",
    );
    expect(r.verdict).toBe("clean");
    expect(r.counts.total).toBe(0);
  });
});

describe("factCheckArticle — extraction correctness", () => {
  it("finds claims in every sentence, not just the first", () => {
    // Regression: the patterns are /g, and reusing one RegExp across sentences
    // carries lastIndex forward and silently skips later matches.
    const r = factCheckArticle(
      "<p>First, 10% of users churn. Then 20% more leave. Finally 30% stay.</p>",
    );
    expect(r.claims.map((c) => c.text)).toEqual(["10%", "20%", "30%"]);
  });

  it("finds claims across separate blocks", () => {
    const r = factCheckArticle("<p>About 11% here.</p><p>And 22% there.</p>");
    expect(r.claims).toHaveLength(2);
  });

  it("does not let a heading bleed into the paragraph below it", () => {
    const r = factCheckArticle("<h2>Costs and savings</h2><p>You save 40% overall.</p>");
    expect(r.claims[0].sentence).toBe("You save 40% overall.");
  });

  it("does not split a sentence on a decimal point", () => {
    const r = factCheckArticle("<p>The average was 12.5% across the sample.</p>");
    expect(r.claims[0].sentence).toBe("The average was 12.5% across the sample.");
  });

  it("does not split a sentence on a common abbreviation", () => {
    const r = factCheckArticle("<p>Some tools, e.g. the usual ones, claim 90% accuracy.</p>");
    expect(r.claims[0].sentence).toContain("e.g.");
    expect(r.claims[0].sentence).toContain("90%");
  });

  it("produces stable ids across identical runs", () => {
    const html = "<p>Exactly 64% of them.</p>";
    expect(factCheckArticle(html).claims[0].id).toBe(factCheckArticle(html).claims[0].id);
  });
});

describe("factCheckArticle — corroboration", () => {
  it("marks a figure that also appears on a ranking page, without calling it verified", () => {
    const r = factCheckArticle(
      "<p>Some 67% of stores never do this.</p>",
      research([
        { title: "Why 67% of stores skip it", description: "", domain: "competitor.com" },
      ]),
    );
    expect(r.claims[0].status).toBe("corroborated");
    expect(r.claims[0].note).toContain("not that it is");
    expect(r.claims[0].note).toContain("competitor.com");
  });

  it("still flags a figure no competitor mentions", () => {
    const r = factCheckArticle(
      "<p>Some 67% of stores never do this.</p>",
      research([{ title: "Unrelated page", description: "nothing", domain: "competitor.com" }]),
    );
    expect(r.claims[0].status).toBe("unsourced");
  });
});
