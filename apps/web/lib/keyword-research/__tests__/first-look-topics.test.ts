import { describe, expect, it } from "vitest";
import {
  bestCase,
  demandScore,
  describeScore,
  pageScore,
  parseSuggestions,
  reachScore,
  rejectBeforeResults,
  rejectOnResults,
  scoreTopic,
  selectionReasons,
  suggestCachePrefix,
  suggestTopicsPrompt,
  topicBrief,
  UNMEASURED_DEMAND,
  type ChosenTopic,
  type SuggestedTopic,
} from "../first-look-topics";
import { contextKey, readOpportunity } from "../opportunity";
import { readResultsPage, type ResultsPageEntry } from "../results-page";

const TOPIC: SuggestedTopic = {
  query: "how to apply for a housing grant",
  fromList: false,
  reader: "Residents looking for public support",
  job: "Find out whether they qualify and how to apply",
  offering: "The scheme finder",
  angle: "How to apply for a housing grant: eligibility, documents and steps",
  shape: "howTo",
  fit: 5,
  kind: "question",
  why: "The site's readers come to it to understand public support they can claim.",
};

const article = (n: number, term = "housing grant"): ResultsPageEntry => ({
  rank: n, title: `How to apply for a ${term}: a guide`, url: `https://news-${n}.example/blog/${term.replace(/ /g, "-")}-guide`, description: `A guide to the ${term}.`,
});
const provider = (n: number): ResultsPageEntry => ({ rank: n, title: `Housing grant help | Acme ${n} | Book now`, url: `https://provider-${n}.example/`, description: "Housing grant applications done for you. Call us today" });

describe("the suggestion prompt", () => {
  it("asks for readers, not only buyers, and gives the model the site, its pages, its searches and its rivals", () => {
    const prompt = suggestTopicsPrompt({
      business: { name: "Example Relief", description: "Independent guides to public support schemes.", audiences: ["citizens seeking support"], offerings: ["scheme guides"] },
      domain: "https://relief.example",
      language: "English",
      pages: [{ title: "Find schemes", path: "/find-schemes/" }],
      pool: [
        { term: "housing grant eligibility", volume: 320, difficulty: 12 },
        { term: "grant application status", volume: null, difficulty: null, parked: true },
      ],
      rivalPages: [{ rival: "rival.example", pages: ["how to check grant status online"] }],
    });
    expect(prompt).toMatch(/Not only people about to buy/);
    expect(prompt).toContain("citizens");
    expect(prompt).toContain("Domain: relief.example");
    expect(prompt).toContain("- Find schemes (/find-schemes/)");
    expect(prompt).toContain("- housing grant eligibility (320/month, difficulty 12)");
    // The buyer test's refusal is said as what it was: a buyers-only check.
    expect(prompt).toContain("- grant application status (volume not measured, an earlier buyers-only check refused it)");
    expect(prompt).toContain("- rival.example: how to check grant status online");
    // The instructions come first and are the cached part.
    expect(prompt.slice(suggestCachePrefix(prompt))).toMatch(/^The site:/);
  });
});

describe("parseSuggestions", () => {
  it("keeps complete topics, one per search, and drops the rest", () => {
    const parsed = parseSuggestions({
      topics: [
        TOPIC,
        { ...TOPIC, query: "  How To Apply For A  Housing Grant " },
        { ...TOPIC, query: "grant deadlines", reader: "" },
        { ...TOPIC, query: "grant deadlines 2026", fit: 9, kind: "nonsense" },
        { ...TOPIC, query: "who qualifies for a housing grant", fit: 3.6, shape: "poem" },
      ],
    });
    expect(parsed.map((t) => t.query)).toEqual(["how to apply for a housing grant", "who qualifies for a housing grant"]);
    expect(parsed[1]).toMatchObject({ fit: 4, shape: "explainer" });
  });
  it("is empty, not an error, for an unusable reply", () => {
    expect(parseSuggestions(null)).toEqual([]);
    expect(parseSuggestions({ topics: "no" })).toEqual([]);
  });
});

describe("scoring", () => {
  it("counts unmeasured demand as neutral, and any measured volume above it", () => {
    expect(demandScore(null)).toBe(UNMEASURED_DEMAND);
    expect(demandScore(0)).toBe(UNMEASURED_DEMAND);
    expect(demandScore(10)).toBeGreaterThan(UNMEASURED_DEMAND);
    expect(demandScore(1_000)).toBeGreaterThan(demandScore(100));
    expect(demandScore(1_000_000)).toBe(1);
  });
  it("reads reach against the site's authority", () => {
    expect(reachScore(null, 10)).toBe(0.6);
    expect(reachScore(20, 30)).toBeGreaterThan(reachScore(60, 30));
    expect(reachScore(90, 0)).toBeGreaterThan(0);
  });
  it("prefers results pages that articles win, and one the site already holds less", () => {
    const editorial = readResultsPage([article(1), article(2), article(3)], { term: "housing grant" });
    expect(pageScore(null)).toBe(0.5);
    expect(pageScore({ reading: editorial })).toBe(1);
    expect(pageScore({ reading: editorial, ownUrl: "https://relief.example/grant" })).toBeLessThan(0.5);
  });
  it("ranks a better-fitting unmeasured topic above a measured one that barely fits", () => {
    const fits = scoreTopic({ fit: 5, kind: "question" }, { volume: null, difficulty: null, authority: 5 });
    const measured = scoreTopic({ fit: 2, kind: "question" }, { volume: 5_000, difficulty: 10, authority: 5 });
    expect(fits.total).toBeGreaterThan(measured.total);
    expect(fits.demandMeasured).toBe(false);
    expect(measured.demandMeasured).toBe(true);
    // Measured demand wins between two topics that fit the same.
    const twin = scoreTopic({ fit: 5, kind: "question" }, { volume: 300, difficulty: null, authority: 5 });
    expect(twin.total).toBeGreaterThan(fits.total);
  });
  it("knows the most an unread topic could still score", () => {
    const s = scoreTopic(TOPIC, { volume: null, difficulty: null, authority: null });
    expect(bestCase(s)).toBeCloseTo(s.total + 12.5, 5);
    expect(describeScore(s)).toMatch(/^\d+(\.\d)?\/100: fit 1\.00, demand unmeasured, reach 0\.60, page 0\.50$/);
  });
});

describe("what removes a topic", () => {
  const ctx = { domain: "relief.example", business: { competitors: ["rivalaid.example"], competitorNames: ["Grant Helpers"] } };
  it("removes names, navigational and off-topic searches before any results page", () => {
    expect(rejectBeforeResults(TOPIC, ctx)).toBeNull();
    expect(rejectBeforeResults({ ...TOPIC, kind: "brand" }, ctx)).toBe("brand");
    expect(rejectBeforeResults({ ...TOPIC, kind: "navigational" }, ctx)).toBe("navigational");
    expect(rejectBeforeResults({ ...TOPIC, kind: "offtopic" }, ctx)).toBe("offtopic");
    expect(rejectBeforeResults({ ...TOPIC, fit: 1 }, ctx)).toBe("offtopic");
    expect(rejectBeforeResults({ ...TOPIC, query: "rivalaid housing grant" }, ctx)).toBe("brand");
    expect(rejectBeforeResults({ ...TOPIC, query: "grant helpers review" }, ctx)).toBe("brand");
    // The site's own name: someone looking for it, not for an article.
    expect(rejectBeforeResults({ ...TOPIC, query: "examplerelief housing grant login" }, { ...ctx, domain: "examplerelief.example" })).toBe("brand");
  });
  it("never removes a topic for unmeasured demand, a buyer test or a transactional label alone", () => {
    expect(rejectBeforeResults({ ...TOPIC, kind: "transactional" }, ctx)).toBeNull();
    expect(rejectBeforeResults({ ...TOPIC, fit: 2 }, ctx)).toBeNull();
  });
  it("removes a search whose results are providers' own pages", () => {
    const providers = readResultsPage([1, 2, 3, 4, 5, 6, 7].map(provider), { term: "housing grant" });
    expect(rejectOnResults(providers)).toBe("needs_page");
    expect(rejectOnResults(readResultsPage([article(1), article(2)], { term: "housing grant" }))).toBeNull();
  });
});

describe("the brief", () => {
  const CONTEXT = { domain: "relief.example", business: { name: "Example Relief" }, languageCode: "en", locationCode: 2586 };
  const fingerprint = contextKey(CONTEXT);
  const chosen = (organic: ResultsPageEntry[], volume: number | null = null): ChosenTopic => {
    const reading = readResultsPage(organic, { term: TOPIC.query });
    const score = scoreTopic(TOPIC, { volume, difficulty: null, authority: null, page: { reading } });
    return { topic: TOPIC, score, volume, difficulty: null, page: { reading }, organicUrls: organic.map((r) => r.url) };
  };

  it("passes the writer's own check, says unmeasured demand plainly, and carries its score", () => {
    const c = chosen([article(1, "housing grant"), article(2, "housing grant"), article(3, "housing grant")]);
    const brief = topicBrief(c, { fingerprint, domain: "relief.example", conversionUrl: "https://relief.example/find-schemes/" })!;
    expect(brief).toMatchObject({ status: "qualified", demand: "unmeasured", format: "article", shape: "howTo", conversionPath: "https://relief.example/find-schemes/" });
    expect(brief.reason).toContain("No search volume is reported for it in this market yet (unmeasured); chosen for fit.");
    expect(brief.firstLookScore?.total).toBe(c.score.total);
    expect(brief.confidence).toBeUndefined();
    // What lib/content/generate.ts reads back before an automatic draft.
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
    expect(selectionReasons(c)[1]).toMatch(/demand is unmeasured/);
  });

  it("is lower confidence on one article, and still passes the check", () => {
    const c = chosen([article(1, "housing grant"), provider(2), provider(3)], 480);
    const brief = topicBrief(c, { fingerprint, domain: "relief.example" })!;
    expect(brief.confidence).toBe("lower");
    expect(brief.demand).toBeUndefined();
    expect(brief.reason).toContain("About 480 searches a month.");
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
  });

  it("is not written with nothing in the results to cite, a dated headline, or a destination off the site", () => {
    expect(topicBrief(chosen([provider(1), provider(2)]), { fingerprint, domain: "relief.example" })).toBeNull();
    const dated = { ...chosen([article(1), article(2)]), topic: { ...TOPIC, angle: "Housing grants in 2019" } };
    expect(topicBrief(dated, { fingerprint, domain: "relief.example" })).toBeNull();
    const elsewhere = topicBrief(chosen([article(1), article(2)]), { fingerprint, domain: "relief.example", conversionUrl: "https://other.example/buy" })!;
    expect(elsewhere.conversionPath).toBe("https://relief.example");
  });
});
