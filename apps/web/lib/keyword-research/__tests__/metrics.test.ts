import { describe, expect, it } from "vitest";
import { parseOverviewItem } from "../metrics";
import { parseSeedList } from "../pipeline";
import { withInstructions } from "../instructions";

// Shapes copied from the live keyword_overview response on 2026-09-04.
describe("parseOverviewItem", () => {
  it("reads volume, cpc, difficulty and the provider's intent", () => {
    const r = parseOverviewItem({
      keyword: "cal.com vs calendly",
      keyword_info: { search_volume: 210, cpc: null, competition: 0.08 },
      keyword_properties: { keyword_difficulty: 12 },
      search_intent_info: { main_intent: "navigational" },
    })!;
    expect(r).toEqual({ term: "cal.com vs calendly", volume: 210, difficulty: 12, cpc: null, intent: "navigational" });
  });
  it("treats difficulty 0 on a real-volume term as not computed", () => {
    const r = parseOverviewItem({
      keyword: "notion alternatives",
      keyword_info: { search_volume: 1600, cpc: 10.35 },
      keyword_properties: { keyword_difficulty: 0 },
      search_intent_info: { main_intent: "informational" },
    })!;
    expect(r.difficulty).toBeNull();
    expect(r.volume).toBe(1600);
    expect(r.intent).toBe("info");
  });
  it("treats a 0 difficulty as unmeasured whatever the volume, and falls back to the lexical intent", () => {
    // A live run handed the model a 720-volume term at KD 0 and it read "easiest".
    // DataForSEO reports 0 when it did not compute a score, so 0 is never a measurement.
    const r = parseOverviewItem({ keyword: "best crm for dentists", keyword_info: { search_volume: 90 }, keyword_properties: { keyword_difficulty: 0 } })!;
    expect(r.difficulty).toBeNull();
    expect(r.intent).toBe("commercial");
  });
  it("returns null without a keyword and null metrics when fields are missing", () => {
    expect(parseOverviewItem({})).toBeNull();
    expect(parseOverviewItem({ keyword: "x" })).toEqual({ term: "x", volume: null, difficulty: null, cpc: null, intent: "info" });
  });
});

describe("parseSeedList", () => {
  it("survives a fence and a preamble, cleans and de-duplicates", () => {
    const raw = 'Sure! ```json\n{"seeds": ["Warehouse Slotting Software", "warehouse slotting software", "x", 42, "wms for 3PL?"]}\n```';
    expect(parseSeedList(raw)).toEqual(["warehouse slotting software", "wms for 3pl"]);
  });
  it("returns [] on junk", () => {
    expect(parseSeedList("no json here")).toEqual([]);
    expect(parseSeedList('{"seeds": "not a list"}')).toEqual([]);
  });
});

describe("withInstructions", () => {
  it("prepends a labelled block only when there are instructions", () => {
    expect(withInstructions("", "PROMPT")).toBe("PROMPT");
    expect(withInstructions("  UK only  ", "PROMPT")).toBe("KEYWORD INSTRUCTIONS FROM THE SITE OWNER (follow these first):\nUK only\n\nPROMPT");
  });
});

import { languageCodeOf } from "../pipeline";

describe("languageCodeOf", () => {
  it("accepts a locale key, a code, or the label a wizard stored, and defaults to en", () => {
    expect(languageCodeOf("it")).toBe("it");
    expect(languageCodeOf("en-gb")).toBe("en");
    expect(languageCodeOf("English")).toBe("en");
    expect(languageCodeOf("Italian")).toBe("it");
    expect(languageCodeOf("zh-CN")).toBe("zh-CN");
    expect(languageCodeOf(null)).toBe("en");
    expect(languageCodeOf("klingon")).toBe("en");
  });
});

import { isBranded } from "../pipeline";

describe("isBranded", () => {
  it("catches the competitor's name in any spacing, leaves generic terms alone", () => {
    expect(isBranded("uipath stock", "uipath")).toBe(true);
    expect(isBranded("ui path alternatives", "uipath")).toBe(true);
    expect(isBranded("cal.com vs calendly", "cal.com")).toBe(true);
    expect(isBranded("rpa software", "uipath")).toBe(false);
    expect(isBranded("anything", "ai")).toBe(false);
  });
});
