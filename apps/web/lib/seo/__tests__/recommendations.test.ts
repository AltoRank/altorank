import { describe, it, expect } from "vitest";
import { assessKeywordQuality, normalizeTarget } from "../recommendations";

const terms = (...t: string[]) => new Set(t.map((x) => x.toLowerCase()));

describe("assessKeywordQuality — provider noise", () => {
  it("accepts an ordinary multi-word query", () => {
    expect(assessKeywordQuality("seo for agencies", terms()).quality).toBe("ok");
  });

  it("rejects a term containing a single-letter word", () => {
    // "s eo" arrives from the keyword API with real-looking volume.
    const r = assessKeywordQuality("s eo", terms());
    expect(r.quality).toBe("suspect");
    expect(r.note).toContain("single-letter");
  });

  it("rejects a split spelling of another tracked keyword", () => {
    const r = assessKeywordQuality("zap ier", terms("zapier", "zap ier"));
    expect(r.quality).toBe("suspect");
    expect(r.note).toContain("zapier");
  });

  it("rejects characters a searcher would not type", () => {
    expect(assessKeywordQuality("_zapier", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("all & one", terms()).quality).toBe("suspect");
  });

  it("rejects a leading negation or function word", () => {
    // Wrote "No Keywords Showing? What It Means and How to Fix It" for altorank.co.
    expect(assessKeywordQuality("no keywords", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("and seo", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("keyword research", terms()).quality).toBe("ok");
  });

  it("rejects a term that repeats a word", () => {
    expect(assessKeywordQuality("seo and seo", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("seo what is seo", terms()).quality).toBe("suspect");
  });

  it("rejects a trailing two-letter fragment", () => {
    // "seo co" is a truncation of "seo company" and reads as a typo in a title.
    expect(assessKeywordQuality("seo co", terms()).quality).toBe("suspect");
  });

  it("rejects anything too short to be a query", () => {
    expect(assessKeywordQuality("ai", terms()).quality).toBe("suspect");
  });

  it("keeps a legitimate hyphenated or apostrophised term", () => {
    expect(assessKeywordQuality("e-commerce platform", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("google's algorithm", terms()).quality).toBe("ok");
  });
});

describe("normalizeTarget — cannibalisation", () => {
  it("collapses word order and connecting words to one target", () => {
    // Caught live: the cron wrote "agency seo" then "agency for seo".
    const a = normalizeTarget("agency seo");
    expect(normalizeTarget("agency for seo")).toBe(a);
    expect(normalizeTarget("seo for agencies")).toBe(a);
  });

  it("folds plurals", () => {
    expect(normalizeTarget("seo agencies")).toBe(normalizeTarget("seo agency"));
    expect(normalizeTarget("keyword tools")).toBe(normalizeTarget("keyword tool"));
  });

  it("keeps genuinely different queries apart", () => {
    expect(normalizeTarget("seo automation")).not.toBe(normalizeTarget("seo audit"));
    expect(normalizeTarget("best crm")).not.toBe(normalizeTarget("crm pricing"));
  });

  it("does not strip a double-s ending into a different word", () => {
    expect(normalizeTarget("business")).toBe("business");
  });

  it("is order independent", () => {
    expect(normalizeTarget("content marketing")).toBe(normalizeTarget("marketing content"));
  });
});
