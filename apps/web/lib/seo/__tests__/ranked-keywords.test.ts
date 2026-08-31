import { describe, it, expect } from "vitest";
import {
  parseRankedItem,
  groupByPage,
  strikingDistance,
  type RankedKeyword,
} from "../ranked-keywords";

// A row shaped the way the DataForSEO Labs docs describe it. This is a fixture,
// not a captured response: until someone runs this against live credentials the
// shape is an assumption, which is why the parser accepts several layouts.
const nested = {
  keyword_data: {
    keyword: "agency seo software",
    keyword_info: { search_volume: 1900, cpc: 12.4 },
    keyword_properties: { keyword_difficulty: 42 },
  },
  ranked_serp_element: {
    serp_item: {
      rank_absolute: 14,
      rank_group: 11,
      url: "https://example.com/blog/agency-seo-software",
    },
  },
};

describe("parseRankedItem", () => {
  it("reads keyword, position and url from the nested shape", () => {
    const r = parseRankedItem(nested)!;
    expect(r.keyword).toBe("agency seo software");
    expect(r.position).toBe(14);
    expect(r.url).toBe("https://example.com/blog/agency-seo-software");
    expect(r.volume).toBe(1900);
    expect(r.difficulty).toBe(42);
  });

  it("prefers rank_absolute over rank_group, because that is what a human sees", () => {
    expect(parseRankedItem(nested)!.position).toBe(14);
  });

  it("falls back to rank_group when absolute is absent", () => {
    const r = parseRankedItem({
      keyword_data: { keyword: "k" },
      ranked_serp_element: { serp_item: { rank_group: 7 } },
    })!;
    expect(r.position).toBe(7);
  });

  it("accepts a keyword flattened to the top level", () => {
    expect(parseRankedItem({ keyword: "flat" })!.keyword).toBe("flat");
  });

  it("returns null when there is no keyword at all, rather than a blank row", () => {
    expect(parseRankedItem({})).toBeNull();
    expect(parseRankedItem({ keyword: "   " })).toBeNull();
  });

  // The house rule: an unknown must never render as a zero.
  it("leaves missing volume and difficulty as null, never 0", () => {
    const r = parseRankedItem({ keyword_data: { keyword: "k" } })!;
    expect(r.volume).toBeNull();
    expect(r.difficulty).toBeNull();
    expect(r.position).toBeNull();
  });

  it("treats non-numeric payload values as unknown", () => {
    const r = parseRankedItem({
      keyword_data: {
        keyword: "k",
        keyword_info: { search_volume: null, cpc: null },
        keyword_properties: { keyword_difficulty: null },
      },
    })!;
    expect(r.volume).toBeNull();
    expect(r.difficulty).toBeNull();
  });

  it("flags editorial URLs so the audit can scope to the blog", () => {
    expect(parseRankedItem(nested)!.isBlogUrl).toBe(true);
    const product = parseRankedItem({
      keyword_data: { keyword: "k" },
      ranked_serp_element: { serp_item: { url: "https://example.com/pricing" } },
    })!;
    expect(product.isBlogUrl).toBe(false);
  });
});

describe("groupByPage", () => {
  const rows: RankedKeyword[] = [
    { keyword: "a", position: 14, url: "https://example.com/blog/x", volume: 100, difficulty: null, cpc: null, isBlogUrl: true },
    { keyword: "b", position: 3, url: "https://example.com/blog/x/", volume: 50, difficulty: null, cpc: null, isBlogUrl: true },
    { keyword: "c", position: 9, url: "https://example.com/pricing", volume: 10, difficulty: null, cpc: null, isBlogUrl: false },
  ];

  it("joins url variants onto one page so a post is not split in three", () => {
    const g = groupByPage(rows);
    expect(g.get("/blog/x")).toHaveLength(2);
    expect(g.size).toBe(2);
  });

  it("orders each page's keywords by best position first", () => {
    expect(groupByPage(rows).get("/blog/x")![0].keyword).toBe("b");
  });

  it("ignores rows with no url rather than inventing a page for them", () => {
    const g = groupByPage([
      { keyword: "z", position: 1, url: null, volume: null, difficulty: null, cpc: null, isBlogUrl: false },
    ]);
    expect(g.size).toBe(0);
  });
});

describe("strikingDistance", () => {
  const rows: RankedKeyword[] = [
    { keyword: "top", position: 2, url: null, volume: 900, difficulty: null, cpc: null, isBlogUrl: false },
    { keyword: "close", position: 14, url: null, volume: 500, difficulty: null, cpc: null, isBlogUrl: false },
    { keyword: "closer-bigger", position: 20, url: null, volume: 800, difficulty: null, cpc: null, isBlogUrl: false },
    { keyword: "far", position: 90, url: null, volume: 9999, difficulty: null, cpc: null, isBlogUrl: false },
    { keyword: "unranked", position: null, url: null, volume: 100, difficulty: null, cpc: null, isBlogUrl: false },
  ];

  it("excludes what already ranks well and what is far out of reach", () => {
    const got = strikingDistance(rows).map((k) => k.keyword);
    expect(got).not.toContain("top");
    expect(got).not.toContain("far");
    expect(got).not.toContain("unranked");
  });

  it("orders by volume, so the biggest reachable win is first", () => {
    expect(strikingDistance(rows).map((k) => k.keyword)).toEqual([
      "closer-bigger",
      "close",
    ]);
  });
});
