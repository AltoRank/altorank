import { describe, it, expect } from "vitest";
import { classifyIntent } from "../intent";
import type { SerpData } from "../brief-data";

const serp = (over: Partial<SerpData> = {}): SerpData => ({
  organic: [],
  peopleAlsoAsk: [],
  ...over,
});

const page = (over: Partial<SerpData["organic"][number]> = {}) => ({
  title: "A page",
  url: "https://example.com/a",
  description: "",
  domain: "example.com",
  wordCount: null,
  ...over,
});

describe("classifyIntent — lexical signals", () => {
  it("reads a how-to keyword as informational", () => {
    const r = classifyIntent("how to bake sourdough bread", "en");
    expect(r.intent).toBe("info");
    expect(r.lexicon).toBe(true);
  });

  it("reads a comparison keyword as commercial", () => {
    expect(classifyIntent("best crm for agencies", "en").intent).toBe("commercial");
  });

  it("reads a purchase keyword as transactional", () => {
    expect(classifyIntent("buy running shoes online", "en").intent).toBe("transactional");
  });

  it("matches multi-word lexemes as phrases", () => {
    const r = classifyIntent("plumber near me", "en");
    expect(r.intent).toBe("transactional");
    expect(r.signals.some((s) => s.reason.includes("near me"))).toBe(true);
  });
});

describe("classifyIntent — non-English locales", () => {
  it("classifies Italian commercial intent", () => {
    expect(classifyIntent("migliori agenzie seo", "it").intent).toBe("commercial");
  });

  it("classifies Italian informational intent through an accent", () => {
    const r = classifyIntent("perché fare seo", "it");
    expect(r.intent).toBe("info");
    expect(r.lexicon).toBe(true);
  });

  it("classifies German transactional intent", () => {
    expect(classifyIntent("laufschuhe kaufen", "de").intent).toBe("transactional");
  });

  it("handles a regional code by using its base language", () => {
    expect(classifyIntent("mejores zapatillas", "es-MX").lexicon).toBe(true);
  });

  it("reports honestly when there is no lexicon rather than scoring in English", () => {
    const r = classifyIntent("パン の 作り方", "ja");
    expect(r.lexicon).toBe(false);
    expect(r.signals.some((s) => s.reason.includes("no lexicon"))).toBe(true);
    // Falls back to the safe default rather than a confident wrong answer.
    expect(r.intent).toBe("info");
    expect(r.confidence).toBe("low");
  });
});

describe("classifyIntent — SERP shape", () => {
  it("treats People Also Ask as an informational signal", () => {
    const r = classifyIntent("widget maintenance", "ja", serp({
      peopleAlsoAsk: ["how often?", "what does it cost?", "is it hard?"],
    }));
    expect(r.intent).toBe("info");
    // Works with no lexicon, which is the point of the SERP family.
    expect(r.lexicon).toBe(false);
  });

  it("treats marketplace results as transactional", () => {
    const r = classifyIntent("widget", "ja", serp({
      organic: [
        page({ domain: "amazon.de" }),
        page({ domain: "zalando.it" }),
        page({ domain: "shop.example.com", url: "https://shop.example.com/product/x" }),
      ],
    }));
    expect(r.intent).toBe("transactional");
  });

  it("detects navigational intent when the keyword names the top-ranking domain", () => {
    const r = classifyIntent("figma", "ja", serp({
      organic: [page({ domain: "figma.com", url: "https://figma.com" })],
    }));
    expect(r.intent).toBe("navigational");
  });

  it("treats long ranking pages as an informational signal", () => {
    const r = classifyIntent("widget", "ja", serp({
      organic: [
        page({ wordCount: 2400 }),
        page({ wordCount: 2100 }),
        page({ wordCount: 1900 }),
      ],
    }));
    expect(r.intent).toBe("info");
  });
});

describe("classifyIntent — confidence", () => {
  it("is low when nothing corroborates the guess", () => {
    expect(classifyIntent("widget", "en").confidence).toBe("low");
  });

  it("rises when lexicon and SERP agree", () => {
    const r = classifyIntent("buy widget online", "en", serp({
      organic: [
        page({ domain: "amazon.com" }),
        page({ domain: "ebay.com" }),
        page({ domain: "etsy.com" }),
      ],
    }));
    expect(r.intent).toBe("transactional");
    expect(r.confidence).toBe("high");
  });

  it("explains itself through signals a human can read", () => {
    const r = classifyIntent("best crm", "en");
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals.every((s) => typeof s.reason === "string" && s.reason.length > 0)).toBe(true);
  });
});
