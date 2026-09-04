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
  it("keeps a genuine 0 difficulty on a small term and falls back to the lexical intent", () => {
    const r = parseOverviewItem({ keyword: "best crm for dentists", keyword_info: { search_volume: 90 }, keyword_properties: { keyword_difficulty: 0 } })!;
    expect(r.difficulty).toBe(0);
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
