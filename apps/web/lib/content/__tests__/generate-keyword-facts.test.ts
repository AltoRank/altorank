import { describe, it, expect } from "vitest";
import { knownKeywordFacts, needsKeywordFactsLookup } from "../generate";

/**
 * Every draft used to pay a keyword_overview call ($0.012) for the keyword's
 * volume and difficulty unless the cron's picker had passed them in as
 * `selection`. The planned fan-out, the "New article" modal, the agent API
 * and write-now never did, so a number discovery had already written to the
 * keyword row was bought again for each article written for that row.
 */
describe("keyword facts for a draft", () => {
  const row = { volume: 1300, difficulty: 22, cpc: 1.4 };

  it("reads the stored row when the caller passed no selection", () => {
    const facts = knownKeywordFacts(undefined, row);
    expect(facts).toEqual({ volume: 1300, difficulty: 22, cpc: 1.4 });
    expect(needsKeywordFactsLookup(facts)).toBe(false);
  });

  it("prefers the picker's selection, and fills the rest from the row", () => {
    const facts = knownKeywordFacts({ volume: 900, difficulty: null }, row);
    expect(facts).toEqual({ volume: 900, difficulty: 22, cpc: 1.4 });
    expect(needsKeywordFactsLookup(facts)).toBe(false);
  });

  it("asks the provider only for a term nothing has measured", () => {
    expect(needsKeywordFactsLookup(knownKeywordFacts(undefined, null))).toBe(true);
    expect(needsKeywordFactsLookup(knownKeywordFacts(undefined, { volume: null, difficulty: null, cpc: null }))).toBe(true);
    // One known number is enough: half-measured is not unmeasured.
    expect(needsKeywordFactsLookup(knownKeywordFacts(undefined, { volume: 0, difficulty: null, cpc: null }))).toBe(false);
  });
});
