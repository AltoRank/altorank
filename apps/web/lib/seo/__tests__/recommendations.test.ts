import { describe, it, expect } from "vitest";
import { assessKeywordQuality, normalizeTarget } from "../recommendations";

const terms = (...t: string[]) => new Set(t.map((x) => x.toLowerCase()));

describe("assessKeywordQuality — provider noise", () => {
  it("flags company names carried over from competitor rankings", () => {
    expect(assessKeywordQuality("worlder inc", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("acme ltd.", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("venture builders", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("inc", terms()).quality).toBe("ok");
  });
  it("accepts an ordinary multi-word query", () => {
    expect(assessKeywordQuality("seo for agencies", terms()).quality).toBe("ok");
  });

  it("rejects a term containing a single-letter word", () => {
    // "s eo" arrives from the keyword API with real-looking volume.
    const r = assessKeywordQuality("s eo", terms());
    expect(r.quality).toBe("suspect");
    expect(r.note).toContain("single-letter");
  });

  it("keeps a one-letter word that is a word", () => {
    // Refused on 2026-09-07 for the "a"; the commonest how-to shape there is.
    expect(assessKeywordQuality("how to start a paid newsletter", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("how to add a signup form", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("come aprire una newsletter a pagamento", terms()).quality).toBe("ok");
    // A lone consonant is still a split word.
    expect(assessKeywordQuality("newsletter s oftware", terms()).quality).toBe("suspect");
  });

  it("still refuses a phrase cut on 'start' or 'add'", () => {
    expect(assessKeywordQuality("ai started", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("newsletter add", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai stop", terms()).quality).toBe("suspect");
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

  it("rejects a term cut mid-phrase", () => {
    // The lully.ai queue led with "ai can" (110/mo) on 2026-09-02.
    expect(assessKeywordQuality("ai can", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai in", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai in retail", terms()).quality).toBe("ok");
  });

  it("rejects two words joined by and", () => {
    expect(assessKeywordQuality("reviews and seo", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai and logistics", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("search and rescue training", terms()).quality).toBe("ok");
  });

  it("rejects a term containing a word that carries no topic", () => {
    // supalabs.co's first keyword set, 2026-09-02.
    for (const t of ["ai stop", "ai makes", "ai are you", "not ai", "its ai", "ai more", "all the answers are correct"]) {
      expect(assessKeywordQuality(t, terms()).quality, t).toBe("suspect");
    }
    // Question words and comparatives are real queries, not fragments.
    for (const t of ["what is logistics", "best warehouse software", "ai native operations"]) {
      expect(assessKeywordQuality(t, terms()).quality, t).toBe("ok");
    }
  });

  it("rejects a preposition plus a bare generic noun", () => {
    expect(assessKeywordQuality("ai in company", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai for business", terms()).quality).toBe("suspect");
    expect(assessKeywordQuality("ai in logistics", terms()).quality).toBe("ok");
    expect(assessKeywordQuality("warehouse management system", terms()).quality).toBe("ok");
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

  it("folds agent and verbal-noun endings, so the writer and the writing are one target", () => {
    // Caught by the autonomous queue: it planned "seo content writing" and
    // "seo content writer" as two articles. Same results page, same reader.
    const a = normalizeTarget("seo content writing");
    expect(normalizeTarget("seo content writer")).toBe(a);
    expect(normalizeTarget("seo content writers")).toBe(a);
    expect(normalizeTarget("seo content writers' guide")).toBe(normalizeTarget("seo content writing guide"));
    expect(normalizeTarget("link building")).toBe(normalizeTarget("link builder"));
  });

  it("leaves a short word whole rather than stemming it to nothing", () => {
    // "user" is not "us", "thing" is not "th": the ending must leave a stem
    // that still says what the word was.
    expect(normalizeTarget("user")).toBe("user");
    expect(normalizeTarget("thing")).toBe("thing");
    expect(normalizeTarget("string")).toBe("string");
  });

  it("folds a silent final e, so the singular meets its own plural", () => {
    // The plural fold produced "websit" from "websites" while "website" stayed
    // whole, so the two halves of the same fold never met. qasimcode.com was
    // given "website design", "website about design" and "website design
    // websites" as three targets, and all three were scheduled.
    const a = normalizeTarget("website design");
    expect(normalizeTarget("website about design")).toBe(a);
    expect(normalizeTarget("website design websites")).toBe(a);
    expect(normalizeTarget("create business websites")).toBe(
      normalizeTarget("creating business websites"),
    );
    expect(normalizeTarget("guide")).toBe(normalizeTarget("guides"));
  });

  it("counts a repeated word once", () => {
    // "business ideas for small businesses" is "idea for small businesses"
    // said twice. Both were stored, both were scheduled.
    expect(normalizeTarget("business ideas for small businesses")).toBe(
      normalizeTarget("idea for small businesses"),
    );
    expect(normalizeTarget("ideas on small businesses")).toBe(
      normalizeTarget("idea for small businesses"),
    );
  });

  it("still keeps genuinely different queries apart after the extra folds", () => {
    expect(normalizeTarget("website design")).not.toBe(normalizeTarget("website hosting"));
    expect(normalizeTarget("dental clinic website")).not.toBe(
      normalizeTarget("beauty salon website"),
    );
    // A word that merely ends in "e" is not a plural of anything.
    expect(normalizeTarget("code")).toBe("code");
    expect(normalizeTarget("site")).toBe("site");
  });
});
