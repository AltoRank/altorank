import { describe, expect, it } from "vitest";
import {
  cannibalization,
  coverageBucket,
  indexCoverage,
  isoDaysAgo,
  normalizeUrl,
  queryOpportunities,
  queryStats,
  rowShape,
  searchPerformance,
  servedUrls,
  shortUrl,
  topPages,
  windows,
  type GscRow,
} from "../analysis";

// A fixed clock: every window here is relative to it.
const TODAY = new Date("2026-09-04T10:00:00Z");
const day = (ago: number) => isoDaysAgo(TODAY, ago);

function row(over: Partial<GscRow> & { metric_date: string }): GscRow {
  return { clicks: 0, impressions: 0, avg_position: null, page_url: null, query: null, article_id: null, ...over };
}

describe("windows", () => {
  it("ends the current window yesterday and butts the previous one against it", () => {
    const w = windows(TODAY, 28);
    expect(w.current).toEqual({ start: "2026-08-07", end: "2026-09-03" });
    expect(w.previous).toEqual({ start: "2026-07-10", end: "2026-08-06" });
    expect(w.since).toBe("2026-07-10");
  });
});

describe("rowShape", () => {
  it("tells the four shapes apart by which keys are set", () => {
    expect(rowShape({ query: null, page_url: null })).toBe("total");
    expect(rowShape({ query: "seo", page_url: null })).toBe("query");
    expect(rowShape({ query: null, page_url: "https://a.co/x" })).toBe("page");
    expect(rowShape({ query: "seo", page_url: "https://a.co/x" })).toBe("query_page");
  });
});

describe("searchPerformance", () => {
  it("reports nothing measured when there are no rows", () => {
    const s = searchPerformance([], TODAY);
    expect(s.hasData).toBe(false);
    expect(s.hasClicks).toBe(false);
    expect(s.current).toHaveLength(28);
    expect(s.previous).toHaveLength(28);
    expect(s.clicks.previous).toBeNull();
    expect(s.clicks.changePct).toBeNull();
  });

  it("uses a day's total row when there is one and query rows when there is not", () => {
    const rows = [
      // Yesterday: total row and query rows both present; the total wins.
      row({ metric_date: day(1), clicks: 10, impressions: 100 }),
      row({ metric_date: day(1), clicks: 4, impressions: 40, query: "a" }),
      row({ metric_date: day(1), clicks: 3, impressions: 30, query: "b" }),
      // Two days ago: only query rows, synced before totals existed.
      row({ metric_date: day(2), clicks: 2, impressions: 20, query: "a" }),
      row({ metric_date: day(2), clicks: 1, impressions: 10, query: "b" }),
      // Page rows never count toward the series: the same clicks again.
      row({ metric_date: day(2), clicks: 3, impressions: 30, page_url: "https://a.co/p" }),
      row({ metric_date: day(2), clicks: 3, impressions: 30, page_url: "https://a.co/p", query: "a" }),
    ];
    const s = searchPerformance(rows, TODAY);
    const last = s.current[s.current.length - 1];
    expect(last).toEqual({ date: day(1), clicks: 10, impressions: 100 });
    expect(s.current[s.current.length - 2]).toEqual({ date: day(2), clicks: 3, impressions: 30 });
    expect(s.clicks.current).toBe(13);
    expect(s.impressions.current).toBe(130);
  });

  it("keeps a measured zero apart from an unmeasured window", () => {
    const measuredZero = searchPerformance([row({ metric_date: day(3), clicks: 0, impressions: 120 })], TODAY);
    expect(measuredZero.hasData).toBe(true);
    expect(measuredZero.hasClicks).toBe(false);
    expect(measuredZero.impressions.current).toBe(120);
    // The previous window was never synced, so there is no delta to state.
    expect(measuredZero.previousMeasured).toBe(false);
    expect(measuredZero.clicks.previous).toBeNull();
  });

  it("compares against the previous window only when that window was synced", () => {
    const s = searchPerformance(
      [row({ metric_date: day(1), clicks: 30, impressions: 300 }), row({ metric_date: day(40), clicks: 20, impressions: 200 })],
      TODAY,
    );
    expect(s.previousMeasured).toBe(true);
    expect(s.clicks).toEqual({ current: 30, previous: 20, changePct: 50 });
    expect(s.impressions.changePct).toBe(50);
  });

  it("gives no percentage against a zero baseline", () => {
    const s = searchPerformance(
      [row({ metric_date: day(1), clicks: 5, impressions: 50 }), row({ metric_date: day(40), clicks: 0, impressions: 10 })],
      TODAY,
    );
    expect(s.clicks.previous).toBe(0);
    expect(s.clicks.changePct).toBeNull();
  });
});

describe("topPages", () => {
  const rows = [
    row({ metric_date: day(1), clicks: 8, impressions: 100, avg_position: 4, page_url: "https://a.co/one", article_id: "art-1" }),
    row({ metric_date: day(2), clicks: 2, impressions: 300, avg_position: 8, page_url: "https://www.a.co/one/" }),
    row({ metric_date: day(1), clicks: 3, impressions: 50, avg_position: 12, page_url: "https://a.co/two" }),
    // Previous window: only /one had clicks.
    row({ metric_date: day(35), clicks: 4, impressions: 80, avg_position: 6, page_url: "https://a.co/one" }),
    // A query row with more clicks than any page must not appear as a page.
    row({ metric_date: day(1), clicks: 50, impressions: 500, query: "big" }),
  ];

  it("merges spellings of one URL, weights position by impressions and carries the article id", () => {
    const [one, two] = topPages(rows, TODAY);
    expect(one.url).toBe("https://a.co/one");
    expect(one.articleId).toBe("art-1");
    expect(one.clicks).toBe(10);
    expect(one.impressions).toBe(400);
    // (4*100 + 8*300) / 400 = 7
    expect(one.position).toBe(7);
    expect(one.ctr).toBe(0.025);
    expect(one.prevClicks).toBe(4);
    expect(one.clicksDelta).toBe(6);
    expect(two.url).toBe("https://a.co/two");
    expect(two.articleId).toBeNull();
    // Synced window, no rows for this page: a measured zero, not a gap.
    expect(two.prevClicks).toBe(0);
    expect(two.clicksDelta).toBe(3);
  });

  it("reports no delta when the previous window was never synced", () => {
    const [one] = topPages(rows.filter((r) => r.metric_date !== day(35)), TODAY);
    expect(one.prevClicks).toBeNull();
    expect(one.clicksDelta).toBeNull();
  });

  it("leaves position null for a page that was never shown", () => {
    const [p] = topPages([row({ metric_date: day(1), clicks: 0, impressions: 0, avg_position: 3, page_url: "https://a.co/x" })], TODAY);
    expect(p.position).toBeNull();
    expect(p.ctr).toBeNull();
  });
});

describe("queryStats and queryOpportunities", () => {
  const rows = [
    row({ metric_date: day(1), clicks: 1, impressions: 100, avg_position: 6, query: "Agency SEO" }),
    row({ metric_date: day(2), clicks: 1, impressions: 100, avg_position: 10, query: "agency seo" }),
    row({ metric_date: day(1), clicks: 30, impressions: 200, avg_position: 1.5, query: "altorank" }),
    row({ metric_date: day(1), clicks: 0, impressions: 400, avg_position: 22, query: "seo tool" }),
    row({ metric_date: day(1), clicks: 0, impressions: 90, avg_position: 15, query: "geo audit" }),
    // Outside the window.
    row({ metric_date: day(40), clicks: 0, impressions: 900, avg_position: 5, query: "old query" }),
  ];

  it("folds case variants of a query into one row", () => {
    const stats = queryStats(rows, TODAY);
    expect(stats.get("agency seo")).toMatchObject({ clicks: 2, impressions: 200, position: 8 });
    expect(stats.has("old query")).toBe(false);
  });

  it("keeps only positions 4-15 with impressions, most shown first", () => {
    const opps = queryOpportunities(rows, TODAY);
    expect(opps.map((o) => o.query.toLowerCase())).toEqual(["agency seo", "geo audit"]);
  });
});

describe("cannibalization", () => {
  const rows = [
    // "seo agency": two pages, one clearly winning -> merge the other in.
    row({ metric_date: day(1), clicks: 20, impressions: 200, avg_position: 5, query: "seo agency", page_url: "https://a.co/seo-agency", article_id: "art-1" }),
    row({ metric_date: day(1), clicks: 2, impressions: 150, avg_position: 14, query: "seo agency", page_url: "https://a.co/agency-seo" }),
    // "geo tools": two pages both earning -> differentiate.
    row({ metric_date: day(2), clicks: 10, impressions: 100, avg_position: 6, query: "geo tools", page_url: "https://a.co/geo-tools" }),
    row({ metric_date: day(2), clicks: 8, impressions: 90, avg_position: 7, query: "geo tools", page_url: "https://a.co/best-geo-tools" }),
    // One page only: not cannibalisation.
    row({ metric_date: day(1), clicks: 5, impressions: 50, avg_position: 3, query: "altorank", page_url: "https://a.co/" }),
    // Two pages, too few impressions to be worth a row.
    row({ metric_date: day(1), clicks: 0, impressions: 3, avg_position: 40, query: "rare", page_url: "https://a.co/r1" }),
    row({ metric_date: day(1), clicks: 0, impressions: 2, avg_position: 50, query: "rare", page_url: "https://a.co/r2" }),
    // Previous window: ignored.
    row({ metric_date: day(40), clicks: 9, impressions: 900, avg_position: 2, query: "altorank", page_url: "https://a.co/old" }),
  ];

  it("finds queries with two or more ranking pages and names the winner", () => {
    const out = cannibalization(rows, TODAY);
    expect(out.map((c) => c.query)).toEqual(["seo agency", "geo tools"]);
    const [seo, geo] = out;
    expect(seo.winner.url).toBe("https://a.co/seo-agency");
    expect(seo.winner.articleId).toBe("art-1");
    expect(seo.pages).toHaveLength(2);
    expect(seo.impressions).toBe(350);
    expect(geo.winner.url).toBe("https://a.co/geo-tools");
  });

  it("suggests a merge for a loser earning a fifth or less, and differentiation otherwise", () => {
    const [seo, geo] = cannibalization(rows, TODAY);
    expect(seo.suggestions).toEqual([
      expect.objectContaining({ url: "https://a.co/agency-seo", action: "merge" }),
    ]);
    expect(seo.suggestions[0].text).toContain("Merge /agency-seo into /seo-agency");
    expect(geo.suggestions[0]).toMatchObject({ url: "https://a.co/best-geo-tools", action: "differentiate" });
  });

  it("suggests differentiation when nobody has clicked yet", () => {
    const [c] = cannibalization(
      [
        row({ metric_date: day(1), clicks: 0, impressions: 60, avg_position: 30, query: "q", page_url: "https://a.co/a" }),
        row({ metric_date: day(1), clicks: 0, impressions: 40, avg_position: 35, query: "q", page_url: "https://a.co/b" }),
      ],
      TODAY,
    );
    // Better position wins the tie on zero clicks.
    expect(c.winner.url).toBe("https://a.co/a");
    expect(c.suggestions[0].action).toBe("differentiate");
  });
});

describe("coverage", () => {
  it("buckets by inspection first, then by having been served in search", () => {
    expect(coverageBucket({ verdict: "PASS" }, false)).toBe("indexed");
    expect(coverageBucket({ verdict: "NEUTRAL" }, true)).toBe("not_indexed");
    expect(coverageBucket({ verdict: "FAIL" }, false)).toBe("not_indexed");
    expect(coverageBucket({ verdict: "VERDICT_UNSPECIFIED" }, false)).toBe("unknown");
    expect(coverageBucket(null, true)).toBe("indexed");
    expect(coverageBucket(null, false)).toBe("unknown");
  });

  it("counts every known page once and keeps unknown as its own bucket", () => {
    const served = servedUrls(
      [
        row({ metric_date: day(1), clicks: 0, impressions: 5, page_url: "https://www.a.co/served/" }),
        // Zero impressions is not evidence of anything.
        row({ metric_date: day(1), clicks: 0, impressions: 0, page_url: "https://a.co/ghost" }),
        row({ metric_date: day(40), clicks: 0, impressions: 50, page_url: "https://a.co/last-month" }),
      ],
      TODAY,
    );
    expect([...served]).toEqual(["a.co/served"]);
    const cov = indexCoverage(
      [
        { url: "https://a.co/served" },
        { url: "https://a.co/served/" }, // same page, different spelling
        { url: "https://a.co/ghost" },
        { url: "https://a.co/last-month" },
        { url: "https://a.co/checked", inspection: { verdict: "PASS" } },
        { url: "https://a.co/excluded", inspection: { verdict: "NEUTRAL" } },
      ],
      served,
    );
    expect(cov).toEqual({ total: 5, indexed: 2, notIndexed: 1, unknown: 2, byInspection: 2, bySearch: 1 });
  });
});

describe("url helpers", () => {
  it("normalises scheme, www and trailing slashes away", () => {
    expect(normalizeUrl("https://www.A.co/Path/")).toBe("a.co/path");
    expect(normalizeUrl("a.co/path")).toBe("a.co/path");
  });
  it("shortens to the path for prose", () => {
    expect(shortUrl("https://a.co/blog/x/")).toBe("/blog/x");
    expect(shortUrl("https://a.co/")).toBe("a.co");
  });
});
