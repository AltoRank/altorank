import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// The 30 rows the brief keeps have to be 30 IDEAS
// ---------------------------------------------------------------------------
//
// `keywords_for_keywords` is $0.0900 a call and 97.8% of what DataForSEO costs
// per draft. It returns ~1,460 rows; this keeps the top 30 by volume and
// lib/ai/prompts.ts shows the writer the top 20 of those.
//
// Measured over 25 production articles, 0-50% of those 20 slots were
// re-phrasings of each other. The worst case is the fixture below, taken from
// the real "ai for management" list: eleven of twenty slots on one idea, every
// row at an identical volume, so they sort adjacently and occupy the TOP of
// the list - which is why deduping after the slice cannot work. Nothing was
// wrong with the call; the same $0.09 was simply buying one concept eleven
// times.

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../client", () => ({ post }));

const { fetchRelatedKeywords } = await import("../brief-data");

const LOCALE = { languageCode: "en", locationCode: 2840 };

/** The flat shape this endpoint actually returns: rows ARE `result`. */
function respond(rows: Array<{ keyword: string; search_volume: number }>) {
  post.mockResolvedValue({
    tasks: [{ result: rows.map((r) => ({ ...r, competition_index: 10 })) }],
  });
}

beforeEach(() => post.mockReset());
afterEach(() => vi.restoreAllMocks());

/**
 * The three phrasing families from the production "ai for management" list,
 * expanded with the filler words the endpoint really returns, so the cap has
 * something to bite on. Every row in a family carries the family's volume,
 * which is what the live data did: they sort adjacently at the TOP.
 */
function duplicateFamily(head: string, tail: string, volume: number) {
  const fillers = ["", " in", " and", " for", " of", " with", " to", " on", " or", " a"];
  return [
    { keyword: `${head} ${tail}`, search_volume: volume },
    { keyword: `${tail} ${head}`, search_volume: volume },
    ...fillers.map((f) => ({ keyword: `${head}${f} ${tail}`, search_volume: volume })),
  ];
}

describe("fetchRelatedKeywords", () => {
  it("spends its 30 slots on distinct ideas rather than on three ideas re-phrased", async () => {
    // 36 duplicate rows across three ideas, at the top by volume, then eight
    // genuinely different terms below them. This is the measured shape: on the
    // real list eleven of the writer's twenty slots went to one concept.
    const distinct = [
      "predictive maintenance",
      "workforce planning software",
      "demand forecasting",
      "warehouse robotics",
      "supplier scorecard",
      "capacity planning",
      "shift scheduling tool",
      "procurement automation",
    ];
    respond([
      ...duplicateFamily("ai", "management", 1900),
      ...duplicateFamily("ai", "inventory", 1600),
      ...duplicateFamily("ai", "logistics", 1400),
      ...distinct.map((keyword, i) => ({ keyword, search_volume: 900 - i })),
    ]);

    const out = await fetchRelatedKeywords("ai for management", LOCALE);
    const terms = out.map((k) => k.keyword);

    // Before the dedupe the top 30 by volume were 30 of the 36 duplicates:
    // three concepts, and not one of the eight distinct terms survived the
    // slice even though the same $0.09 had already bought them.
    for (const term of distinct) expect(terms).toContain(term);
    // Three ideas, one row each. `permutationKey` collapses word order and
    // filler words, which is exactly what this family is.
    expect(terms.filter((t) => t.includes("management"))).toEqual(["ai management"]);
    expect(terms).toHaveLength(11);
  });

  it("collapses word order and filler words, and nothing cleverer", async () => {
    // The honest limit of the rule, stated rather than left to be discovered:
    // a synonym is a different token set and survives. Spelling out acronyms
    // would only ever cover the languages somebody remembered to list.
    respond([
      { keyword: "ai management", search_volume: 1900 },
      { keyword: "ai in management", search_volume: 1900 },
      { keyword: "management ai", search_volume: 1900 },
      { keyword: "artificial intelligence and management", search_volume: 1900 },
    ]);
    const out = await fetchRelatedKeywords("ai for management", LOCALE);
    expect(out.map((k) => k.keyword)).toEqual([
      "ai management",
      "artificial intelligence and management",
    ]);
  });

  it("keeps the best-searched phrasing of an idea, not the first one seen", async () => {
    respond([
      { keyword: "seo and content marketing", search_volume: 1300 },
      { keyword: "content marketing seo", search_volume: 1300 },
      { keyword: "seo content marketing", search_volume: 1600 },
    ]);
    const out = await fetchRelatedKeywords("seo", LOCALE);
    expect(out.map((k) => k.keyword)).toEqual(["seo content marketing"]);
    expect(out[0].searchVolume).toBe(1600);
  });

  it("leaves genuinely different terms alone", async () => {
    respond([
      { keyword: "keyword research tool", search_volume: 5000 },
      { keyword: "backlink checker", search_volume: 4000 },
      { keyword: "rank tracker", search_volume: 3000 },
    ]);
    const out = await fetchRelatedKeywords("seo", LOCALE);
    expect(out).toHaveLength(3);
  });

  it("returns the RelatedKeyword shape, with no dedupe scratch field left on it", async () => {
    // `volume` is added to reuse dedupePermutations and must not leak: the
    // research JSON is stored on `articles.research` and read by the editor.
    respond([{ keyword: "rank tracker", search_volume: 3000 }]);
    const out = await fetchRelatedKeywords("seo", LOCALE);
    expect(Object.keys(out[0]).sort()).toEqual(["competition", "keyword", "searchVolume"]);
  });

  it("still drops the seed itself and exact repeats", async () => {
    respond([
      { keyword: "SEO", search_volume: 9000 },
      { keyword: "rank tracker", search_volume: 3000 },
      { keyword: "rank tracker", search_volume: 3000 },
    ]);
    const out = await fetchRelatedKeywords("seo", LOCALE);
    expect(out.map((k) => k.keyword)).toEqual(["rank tracker"]);
  });

  it("still caps the list at 30, highest demand first", async () => {
    respond(
      Array.from({ length: 60 }, (_, i) => ({ keyword: `distinct term ${i}`, search_volume: i })),
    );
    const out = await fetchRelatedKeywords("seed", LOCALE);
    expect(out).toHaveLength(30);
    expect(out[0].searchVolume).toBe(59);
  });
});
