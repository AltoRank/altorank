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

// ---------------------------------------------------------------------------
// One task for the whole week
// ---------------------------------------------------------------------------
//
// The endpoint is billed per task and takes up to 20 keywords. A signup writes
// seven drafts and bought seven tasks: $0.63 of a $1.929 signup for thirteen
// usable rows (round4 §4, W2). The fan-out knows all seven keywords before it
// dispatches, so one task serves the week.
//
// A multi-seed response has never been observed on this account, so both
// plausible layouts are covered here: the API grouping rows per seed, and the
// flat merged pool a one-seed call returns today.

const { fetchRelatedKeywordsBatch, MAX_SEEDS_PER_TASK } = await import("../brief-data");

/** The merged layout: rows ARE `result`, with nothing naming their seed. */
function respondMerged(rows: Array<{ keyword: string; search_volume: number }>) {
  post.mockResolvedValue({
    tasks: [{ result: rows.map((r) => ({ ...r, competition_index: 10 })) }],
  });
}

/** The grouped layout: one `result` entry per seed, each with its own items. */
function respondGrouped(groups: Record<string, Array<{ keyword: string; search_volume: number }>>) {
  post.mockResolvedValue({
    tasks: [
      {
        result: Object.entries(groups).map(([keyword, rows]) => ({
          keyword,
          items: rows.map((r) => ({ ...r, competition_index: 10 })),
        })),
      },
    ],
  });
}

describe("fetchRelatedKeywordsBatch", () => {
  it("buys one task for seven keywords instead of seven", async () => {
    respondMerged([{ keyword: "newsletter pricing", search_volume: 500 }]);
    await fetchRelatedKeywordsBatch(
      ["paid newsletter", "newsletter tools", "email list", "substack fees",
       "newsletter seo", "rss to email", "newsletter analytics"],
      LOCALE,
    );
    expect(post).toHaveBeenCalledTimes(1);
    const [endpoint, body] = post.mock.calls[0] as [string, Array<{ keywords: string[] }>];
    expect(endpoint).toBe("/keywords_data/google_ads/keywords_for_keywords/live");
    expect(body[0].keywords).toHaveLength(7);
  });

  it("uses the API's own grouping when the payload carries one", async () => {
    respondGrouped({
      "paid newsletter": [{ keyword: "paid newsletter platform", search_volume: 900 }],
      "email list": [{ keyword: "email list building", search_volume: 800 }],
    });
    const out = await fetchRelatedKeywordsBatch(["paid newsletter", "email list"], LOCALE);
    expect(out.get("paid newsletter")!.map((k) => k.keyword)).toEqual(["paid newsletter platform"]);
    expect(out.get("email list")!.map((k) => k.keyword)).toEqual(["email list building"]);
  });

  it("splits a merged pool back to the seed whose words each row contains", async () => {
    respondMerged([
      { keyword: "paid newsletter platform", search_volume: 900 },
      { keyword: "best paid newsletter", search_volume: 700 },
      { keyword: "email list building", search_volume: 800 },
      { keyword: "grow an email list", search_volume: 600 },
    ]);
    const out = await fetchRelatedKeywordsBatch(["paid newsletter", "email list"], LOCALE);
    expect(out.get("paid newsletter")!.map((k) => k.keyword)).toEqual([
      "paid newsletter platform",
      "best paid newsletter",
    ]);
    expect(out.get("email list")!.map((k) => k.keyword)).toEqual([
      "email list building",
      "grow an email list",
    ]);
  });

  it("drops a row that belongs to no seed rather than giving it to all of them", async () => {
    // The writer sees twenty of these. A term with nothing to do with the
    // keyword is worse than a short list, so an unattributable row is not
    // spread across every draft to pad it out.
    respondMerged([
      { keyword: "paid newsletter platform", search_volume: 900 },
      { keyword: "bald nba players", search_volume: 90000 },
    ]);
    const out = await fetchRelatedKeywordsBatch(["paid newsletter", "email list"], LOCALE);
    expect(out.get("paid newsletter")!.map((k) => k.keyword)).toEqual(["paid newsletter platform"]);
    expect(out.get("email list")).toEqual([]);
  });

  it("reports a seed the task answered nothing for, and does not re-buy it", async () => {
    // Measured: `fairnote` got 0 rows for its own $0.09. Zero is an answer.
    respondMerged([{ keyword: "paid newsletter platform", search_volume: 900 }]);
    const out = await fetchRelatedKeywordsBatch(["paid newsletter", "fairnote"], LOCALE);
    expect(out.get("fairnote")).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("answers every key it was asked for, even when the task returns nothing at all", async () => {
    post.mockResolvedValue({ tasks: [{ result: null }] });
    const out = await fetchRelatedKeywordsBatch(["a term", "another term"], LOCALE);
    expect([...out.keys()]).toEqual(["a term", "another term"]);
    expect(out.get("a term")).toEqual([]);
  });

  it("sends one seed once, and answers both callers that asked for it", async () => {
    respondMerged([{ keyword: "paid newsletter platform", search_volume: 900 }]);
    const out = await fetchRelatedKeywordsBatch(["Paid Newsletter", "paid newsletter", "  "], LOCALE);
    const [, body] = post.mock.calls[0] as [string, Array<{ keywords: string[] }>];
    expect(body[0].keywords).toEqual(["Paid Newsletter"]);
    expect(out.get("paid newsletter")!.map((k) => k.keyword)).toEqual(["paid newsletter platform"]);
    expect(out.get("Paid Newsletter")!.map((k) => k.keyword)).toEqual(["paid newsletter platform"]);
    expect(out.has("  ")).toBe(false);
  });

  it("chunks at the endpoint's own ceiling rather than sending a task it will reject", async () => {
    respondMerged([{ keyword: "anything", search_volume: 1 }]);
    const seeds = Array.from({ length: MAX_SEEDS_PER_TASK + 1 }, (_, i) => `seed ${i}`);
    await fetchRelatedKeywordsBatch(seeds, LOCALE);
    expect(post).toHaveBeenCalledTimes(2);
    const first = (post.mock.calls[0] as [string, Array<{ keywords: string[] }>])[1][0].keywords;
    const second = (post.mock.calls[1] as [string, Array<{ keywords: string[] }>])[1][0].keywords;
    expect(first).toHaveLength(MAX_SEEDS_PER_TASK);
    expect(second).toHaveLength(1);
  });

  it("still keeps one phrasing per idea and caps each seed's list at 30", async () => {
    respondMerged([
      ...duplicateFamily("paid", "newsletter", 1900),
      ...Array.from({ length: 40 }, (_, i) => ({
        keyword: `paid newsletter idea ${i}`,
        search_volume: 100 + i,
      })),
    ]);
    const out = await fetchRelatedKeywordsBatch(["paid newsletter", "email list"], LOCALE);
    const terms = out.get("paid newsletter")!.map((k) => k.keyword);
    expect(terms).toHaveLength(30);
    // The twelve phrasings of the seed collapse to one row, exactly as they do
    // on a single-keyword call; batching does not change that rule.
    expect(terms.filter((t) => t.split(" ").length === 2)).toHaveLength(1);
  });
});
