import { describe, it, expect, vi, beforeEach } from "vitest";
import { figureSentences, mergeSourceFigures, figureReviewNote, MAX_PER_PAGE, type SourceFigure } from "../source-figures";
import { buildSystemPrompt, figureRules } from "@/lib/ai/prompts";
import type { ArticleResearch } from "../research";

// A real first article (2026-09-27, a physiotherapy clinic) had no figure at
// all: the writer was told never to invent one and handed nothing to cite,
// while research had downloaded the ranking pages and kept only their word
// counts. Every page and number below is invented.

const PAGE = { url: "https://clinic-a.example/guide", domain: "clinic-a.example" };

const MARKDOWN = [
  "# Physiotherapy or athletic therapy?",
  "Accept cookies to see 100% of this page.",
  "About 62% of the sports injuries we saw last season were ankle or knee sprains, according to our clinic audit.",
  "A first assessment at most clinics costs $90 and includes a movement screen.",
  "| Plan | Price |",
  "| --- | --- |",
  "| Basic | $90 |",
  "Recovery from a grade 2 sprain usually takes 3 to 6 weeks with guided exercise.",
  "Short line 5%.",
  "Our clinicians hold 2 or more post-graduate certificates, and 4x more patients return for follow-ups than last year.",
].join("\n");

describe("figureSentences", () => {
  it("keeps the sentences that state a figure, as the page states them, with the page", () => {
    const out = figureSentences(MARKDOWN, PAGE, "en");
    expect(out.length).toBe(MAX_PER_PAGE);
    expect(out[0]).toEqual({
      sentence: "About 62% of the sports injuries we saw last season were ankle or knee sprains, according to our clinic audit.",
      figures: ["62%"],
      url: PAGE.url,
      domain: PAGE.domain,
    });
    // Furniture, table rows and fragments are not findings.
    expect(out.map((f) => f.sentence).join(" ")).not.toMatch(/cookies|Basic|Short line/);
  });

  it("finds nothing in a language the locale contract does not describe", () => {
    expect(figureSentences("Около 62% пациентов восстанавливаются за шесть недель после травмы.", PAGE, "ru")).toEqual([]);
  });

  it("merges pages round-robin so one page cannot fill the list", () => {
    const a = figureSentences(MARKDOWN, PAGE, "en");
    const b = [{ sentence: "Board data show 12% of licensed physiotherapists also hold a sports certificate.", figures: ["12%"], url: "https://b.example/", domain: "b.example" }];
    const merged = mergeSourceFigures([a, b]);
    expect(merged.map((f) => f.domain)).toEqual(["clinic-a.example", "b.example", "clinic-a.example", "clinic-a.example"]);
  });
});

describe("figureReviewNote", () => {
  const offered: SourceFigure[] = [
    { sentence: "s1", figures: ["62%"], url: "https://a.example", domain: "a.example" },
    { sentence: "s2", figures: ["3 to 6 weeks", "45 minutes"], url: "https://b.example", domain: "b.example" },
  ];

  it("says why a draft has no figure when research found none", () => {
    expect(figureReviewNote([], "<p>Words only.</p>", "en")).toMatch(/state no figure.*fails on purpose/);
    expect(figureReviewNote(undefined, "<p>Words only.</p>", "en")).toMatch(/No ranking page could be read/);
  });

  it("flags figures in a draft that was offered none", () => {
    expect(figureReviewNote([], "<p>About 40% of people recover.</p>", "en")).toMatch(/yet the draft has 1/);
  });

  it("is quiet when the draft cites two of the offered figures, and counts when it does not", () => {
    expect(figureReviewNote(offered, "<p>62% of injuries ... 45 minutes per visit.</p>", "en")).toBeNull();
    expect(figureReviewNote(offered, "<p>No numbers here.</p>", "en")).toMatch(/offered 2 sourced figures and the draft uses 0/);
  });

  it("says the check did not run in an unsupported language rather than reading it as English", () => {
    expect(figureReviewNote([], "<p>текст</p>", "ru")).toMatch(/not looked for in Russian/);
  });
});

const research = (sourceFigures?: SourceFigure[]): ArticleResearch => ({
  keyword: "physiotherapy vs athletic therapy",
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [],
  peopleAlsoAsk: [],
  aiOverview: null,
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1500,
  wordCountBasis: "test",
  layers: [],
  ...(sourceFigures ? { sourceFigures } : {}),
});

describe("the writer is asked for two or three sourced figures, or told there are none", () => {
  it("lists the figures with their pages and asks for two or three, cited in the sentence", () => {
    const p = buildSystemPrompt({
      keyword: "physiotherapy vs athletic therapy",
      research: research([{ sentence: "About 62% of sports injuries were sprains.", figures: ["62%"], url: "https://a.example/x", domain: "a.example" }]),
    });
    expect(p).toContain("FIGURES FROM THE PAGES RESEARCHED");
    expect(p).toContain('- "About 62% of sports injuries were sprains." (https://a.example/x)');
    expect(p).toContain("Use two or three specific figures");
    expect(p).toContain("never a number from memory");
    expect(p).not.toContain("There is no minimum number of statistics");
  });

  it("tells the writer there is nothing to cite when research found no figure", () => {
    for (const r of [research([]), research(), undefined]) {
      const rules = figureRules(r).join("\n");
      expect(rules).toContain("write no statistic, price or percentage");
    }
    expect(buildSystemPrompt({ keyword: "k", research: research([]) })).not.toContain("FIGURES FROM THE PAGES RESEARCHED");
  });

  it("keeps a rewrite's own sourced figures instead of asking it to drop them", () => {
    const rules = figureRules(research([]), { refresh: true }).join("\n");
    expect(rules).toContain("Use specific figures only when sourced");
    expect(rules).not.toContain("write no statistic");
  });

  it("tells the writer not to name a regulator no linked page names", () => {
    const p = buildSystemPrompt({ keyword: "physiotherapy vs athletic therapy" });
    expect(p).toContain("Name a regulator, licensing body, insurer or public plan only when a page");
    expect(p).toContain("A professional association is");
  });
});

// Research keeps the sentences from the pages it already fetched: no second request.
const { serp, fetchSite } = vi.hoisted(() => ({ serp: vi.fn(), fetchSite: vi.fn() }));
vi.mock("../brief-data", () => ({
  fetchAdvancedSerp: (...a: unknown[]) => serp(...a),
  fetchRelatedKeywords: async () => [],
}));
vi.mock("../client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/audit/lenient-fetch", () => ({ fetchSite: (...a: unknown[]) => fetchSite(...a) }));

describe("gatherArticleResearch keeps the figures of the pages it read", () => {
  beforeEach(() => {
    serp.mockReset();
    fetchSite.mockReset();
  });

  it("carries each figure sentence with the page it came from, from the one fetch per page", async () => {
    serp.mockResolvedValue({
      organic: [{ rank: 1, title: "Guide", url: PAGE.url, domain: PAGE.domain, description: "", wordCount: null }],
      peopleAlsoAsk: [],
      aiOverview: null,
    });
    const html = `<html><body><main>${MARKDOWN.split("\n").map((l) => `<p>${l}</p>`).join("")}<p>${"More words about recovery. ".repeat(40)}</p></main></body></html>`;
    fetchSite.mockResolvedValue({ ok: true, status: 200, text: async () => html });
    const { gatherArticleResearch } = await import("../research");
    const r = await gatherArticleResearch({ keyword: "physiotherapy vs athletic therapy", locale: "en" });
    expect(fetchSite).toHaveBeenCalledTimes(1);
    expect(r.sourceFigures?.[0]).toMatchObject({ figures: ["62%"], url: PAGE.url });
    expect(r.layers.find((l) => l.id === "competitor_length")?.detail).toMatch(/3 sentences with a figure kept/);
  });

  it("leaves the list absent when no page could be read, so the note can say so", async () => {
    serp.mockResolvedValue({
      organic: [{ rank: 1, title: "Guide", url: PAGE.url, domain: PAGE.domain, description: "", wordCount: null }],
      peopleAlsoAsk: [],
      aiOverview: null,
    });
    fetchSite.mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    const { gatherArticleResearch } = await import("../research");
    const r = await gatherArticleResearch({ keyword: "k", locale: "en" });
    expect(r.sourceFigures).toBeUndefined();
  });
});
