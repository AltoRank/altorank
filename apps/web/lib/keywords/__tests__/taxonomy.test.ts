import { describe, it, expect } from "vitest";
import { classifyKeyword, targetWordCountFor, taxonomyLabel, TAXONOMY_LABELS } from "../taxonomy";

describe("classifyKeyword", () => {
  it("reads a walkthrough off 'how to' and 'guide'", () => {
    expect(classifyKeyword("how to set up google search console")).toEqual({ article_type: "guide", article_subtype: "howTo" });
    expect(classifyKeyword("technical seo guide")).toEqual({ article_type: "guide", article_subtype: "howTo" });
  });
  it("reads a definition off 'what is' and 'why'", () => {
    expect(classifyKeyword("what is generative engine optimization").article_subtype).toBe("explainer");
    expect(classifyKeyword("why does seo take so long").article_subtype).toBe("explainer");
  });
  it("reads a comparison off vs, alternatives and compare", () => {
    expect(classifyKeyword("ahrefs vs semrush").article_subtype).toBe("comparison");
    expect(classifyKeyword("surfer seo alternatives").article_subtype).toBe("comparison");
    expect(classifyKeyword("compare crm systems").article_subtype).toBe("comparison");
  });
  it("reads a round-up off best, top and a leading number", () => {
    expect(classifyKeyword("best seo strategies")).toEqual({ article_type: "listicle", article_subtype: "roundup" });
    expect(classifyKeyword("top link building tactics").article_type).toBe("listicle");
    expect(classifyKeyword("10 ways to speed up wordpress").article_subtype).toBe("roundup");
  });
  it("reads a resources list off tools and software, examples off examples and templates", () => {
    expect(classifyKeyword("open source seo tools")).toEqual({ article_type: "listicle", article_subtype: "resources" });
    expect(classifyKeyword("best crm software").article_subtype).toBe("resources");
    expect(classifyKeyword("landing page examples").article_subtype).toBe("examples");
    expect(classifyKeyword("content calendar templates").article_subtype).toBe("examples");
  });
  it("reads a reference off checklist and pricing", () => {
    expect(classifyKeyword("seo audit checklist").article_subtype).toBe("reference");
  });
  it("leans on intent when the term carries no format words", () => {
    expect(classifyKeyword("warehouse management system", "commercial").article_subtype).toBe("comparison");
    expect(classifyKeyword("warehouse management system", "info").article_subtype).toBe("explainer");
    expect(classifyKeyword("warehouse management system").article_subtype).toBe("explainer");
  });
  it("is case- and whitespace-insensitive", () => {
    expect(classifyKeyword("  HOW TO   Rank  ").article_subtype).toBe("howTo");
  });
});

describe("labels and lengths", () => {
  it("has a label for every subtype and none for garbage", () => {
    for (const k of Object.keys(TAXONOMY_LABELS)) expect(taxonomyLabel(k)).toBeTruthy();
    expect(taxonomyLabel("novella")).toBeNull();
    expect(taxonomyLabel(null)).toBeNull();
  });
  it("resolves a named band to its midpoint and auto to the research number", () => {
    expect(targetWordCountFor("short", 2300)).toBe(1400);
    expect(targetWordCountFor("comprehensive", 900)).toBe(3700);
    expect(targetWordCountFor("auto", 2300)).toBe(2300);
    expect(targetWordCountFor(null, 2300)).toBe(2300);
    // Unknown research and auto: undefined, never a made-up number.
    expect(targetWordCountFor("auto", undefined)).toBeUndefined();
  });
});
