import { describe, it, expect } from "vitest";
import { knownBrandNames, mayNameOtherBrands, namesKnownBrand } from "../brand-terms";
import { buildResearchSection, buildSystemPrompt } from "@/lib/ai/prompts";
import type { ArticleResearch } from "../research";
import type { SourceReview } from "../source-classes";

// A first draft of 2026-10-22 for a skincare store named four rival brands
// "that come up often in that search". Every name below is invented.

const KW = "baby eczema cream";

const review = (over: Partial<SourceReview> = {}): SourceReview =>
  ({
    ownDomain: "littlepetal.example",
    rivals: ["Softpaw Botanicals", "dewdrop-baby.example"],
    classes: [{ host: "eczema-society.example", class: "information", by: "model" }],
    model: "ok",
    heldBack: [],
    ...over,
  }) as SourceReview;

const research = (over: Partial<ArticleResearch> = {}): ArticleResearch => ({
  keyword: KW,
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [
    { rank: 1, title: "Oatwell Baby Eczema Cream", url: "https://www.oatwell.example/baby", domain: "oatwell.example", description: "", wordCount: 900 },
    { rank: 2, title: "Eczema in babies", url: "https://eczema.example/babies", domain: "eczema.example", description: "", wordCount: 1500 },
  ],
  peopleAlsoAsk: [],
  aiOverview: null,
  relatedKeywords: [
    { keyword: "best cream for baby eczema", searchVolume: 900, competition: null },
    { keyword: "oatwell baby eczema cream", searchVolume: 700, competition: null },
    { keyword: "softpaw botanicals eczema balm", searchVolume: 300, competition: null },
    { keyword: "dewdrop baby cream", searchVolume: 200, competition: null },
    { keyword: "zinc oxide for baby eczema", searchVolume: 400, competition: null },
    { keyword: "little petal eczema cream", searchVolume: 50, competition: null },
  ],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1500,
  wordCountBasis: "test",
  layers: [],
  sourceReview: review(),
  ...over,
});

describe("mayNameOtherBrands", () => {
  it("is no for an ordinary article, yes for a comparison the brief or keyword asks for", () => {
    expect(mayNameOtherBrands({ keyword: KW })).toBe(false);
    expect(mayNameOtherBrands({ keyword: "how to choose a baby eczema cream", title: "Choosing a cream" })).toBe(false);
    expect(mayNameOtherBrands({ keyword: KW, articleSubtype: "comparison" })).toBe(true);
    expect(mayNameOtherBrands({ keyword: "oatwell vs softpaw" })).toBe(true);
    expect(mayNameOtherBrands({ keyword: "oatwell alternatives" })).toBe(true);
    expect(mayNameOtherBrands({ keyword: KW, instructions: "Compare the three best-known creams." })).toBe(true);
    expect(mayNameOtherBrands({ keyword: KW, mentionSimilarProducts: true })).toBe(true);
  });
});

describe("knownBrandNames and namesKnownBrand", () => {
  it("collects the rivals and ranking hosts, not the topic word or the business itself", () => {
    const names = knownBrandNames(research(), { keyword: KW });
    expect([...names].sort()).toEqual(["dewdropbaby", "eczemasociety", "oatwell", "softpawbotanicals"]);
    // eczema.example is the topic, littlepetal.example is the business.
    expect(names.has("eczema")).toBe(false);
    expect(names.has("littlepetal")).toBe(false);
  });

  it("matches a brand as a run of whole words", () => {
    const names = new Set(["softpawbotanicals", "oatwell"]);
    expect(namesKnownBrand("Softpaw Botanicals eczema balm", names)).toBe(true);
    expect(namesKnownBrand("oatwell cream", names)).toBe(true);
    expect(namesKnownBrand("oat well-being for babies", names)).toBe(true);
    expect(namesKnownBrand("oatwellness tips", names)).toBe(false);
    expect(namesKnownBrand("zinc oxide cream", names)).toBe(false);
  });
});

describe("the writer's prompt", () => {
  it("drops related searches that name another brand and forbids naming them", () => {
    const prompt = { keyword: KW, research: research() };
    const system = buildSystemPrompt(prompt);
    expect(system).toContain("OTHER BRANDS:");
    expect(system).toContain("Do not name any other business's brand");
    const terms = system.slice(system.indexOf("RELATED TERMS TO COVER"), system.indexOf("OTHER BRANDS:"));
    expect(terms).toContain("best cream for baby eczema");
    expect(terms).toContain("zinc oxide for baby eczema");
    expect(terms).toContain("little petal eczema cream");
    expect(terms).not.toContain("oatwell");
    expect(terms).not.toContain("softpaw");
    expect(terms).not.toContain("dewdrop");
  });

  it("keeps every term and drops the rule for a comparison", () => {
    const system = buildSystemPrompt({
      keyword: KW,
      research: research(),
      brief: { answers: [], articleType: "guide", articleSubtype: "comparison" },
    });
    expect(system).not.toContain("OTHER BRANDS:");
    expect(system).toContain("oatwell baby eczema cream");
    expect(system).toContain("softpaw botanicals eczema balm");
  });

  it("leaves the research section as it was when no brands are to be filtered", () => {
    expect(buildResearchSection(research()).join("\n")).toContain("oatwell baby eczema cream");
  });
});
