import { describe, it, expect } from "vitest";
import {
  detectOpportunities,
  aggregateQueries,
  splitWindows,
  expectedCtr,
  headingMatchesQuery,
  headingsOf,
  type QueryStats,
  type PageInput,
} from "../detect";

const stats = (q: string, over: Partial<QueryStats>): [string, QueryStats] => [
  q,
  { query: q, clicks: 0, impressions: 0, ctr: 0, position: 50, ...over },
];

const page = (over: Partial<PageInput> = {}): PageInput => ({
  url: "https://example.com/blog/booking-software",
  site_page_id: null,
  article_id: "a1",
  keyword: "booking software",
  word_count: 1400,
  headings: ["Booking software for gyms", "What booking software does", "Pricing"],
  ...over,
});

const run = (p: PageInput, cur: [string, QueryStats][], prev: [string, QueryStats][] = []) =>
  detectOpportunities({ page: p, current: new Map(cur), previous: new Map(prev) });

describe("detectOpportunities", () => {
  it("almost_there: page two with real impressions", () => {
    const out = run(page(), [stats("booking software", { position: 8.4, impressions: 340, clicks: 12, ctr: 12 / 340 })]);
    const hit = out.find((d) => d.opportunity === "almost_there");
    expect(hit).toBeDefined();
    expect(hit!.evidence.position).toBe(8.4);
    expect(hit!.evidence.impressions).toBe(340);
    expect(hit!.evidence.clicks).toBe(12);
    // Not measured: no previous window, no CTR expectation for this verdict.
    expect(hit!.evidence.prev_position).toBeNull();
    expect(hit!.evidence.prev_clicks).toBeNull();
    expect(hit!.evidence.expected_ctr).toBeNull();
  });

  it("almost_there needs the impressions, not just the position", () => {
    const out = run(page(), [stats("booking software", { position: 9, impressions: 40 })]);
    expect(out.map((d) => d.opportunity)).not.toContain("almost_there");
  });

  it("ctr_gap: top five, far under the curve, with the expectation recorded", () => {
    const out = run(page(), [stats("booking software", { position: 2, impressions: 1000, clicks: 30, ctr: 0.03 })]);
    const hit = out.find((d) => d.opportunity === "ctr_gap");
    expect(hit).toBeDefined();
    expect(hit!.evidence.expected_ctr).toBe(expectedCtr(2));
    expect(hit!.evidence.ctr).toBe(0.03);
  });

  it("ctr_gap does not fire on a healthy CTR or on too few impressions", () => {
    expect(
      run(page(), [stats("booking software", { position: 2, impressions: 1000, clicks: 140, ctr: 0.14 })]).map((d) => d.opportunity),
    ).not.toContain("ctr_gap");
    expect(
      run(page(), [stats("booking software", { position: 2, impressions: 20, clicks: 0, ctr: 0 })]).map((d) => d.opportunity),
    ).not.toContain("ctr_gap");
  });

  it("declining: three places lost against the previous window", () => {
    const out = run(
      page(),
      [stats("booking software", { position: 7.5, impressions: 300, clicks: 20, ctr: 20 / 300 })],
      [stats("booking software", { position: 4.2, impressions: 320, clicks: 40, ctr: 40 / 320 })],
    );
    const hit = out.find((d) => d.opportunity === "declining");
    expect(hit).toBeDefined();
    expect(hit!.evidence.prev_position).toBe(4.2);
    expect(hit!.evidence.prev_clicks).toBe(40);
  });

  it("declining: clicks down 30% with enough of a base", () => {
    const out = run(
      page(),
      [stats("booking software", { position: 3, impressions: 300, clicks: 20, ctr: 20 / 300 })],
      [stats("booking software", { position: 3, impressions: 320, clicks: 40, ctr: 40 / 320 })],
    );
    expect(out.map((d) => d.opportunity)).toContain("declining");
  });

  it("declining falls back to SERP checks when Search Console has no previous window", () => {
    const out = run(
      page({ serp: { position: 9, prev_position: 4 } }),
      [stats("booking software", { position: 9, impressions: 300, clicks: 5, ctr: 5 / 300 })],
    );
    expect(out.map((d) => d.opportunity)).toContain("declining");
  });

  it("content_gap: ranks but no heading carries the query", () => {
    const out = run(
      page({ headings: ["Our story", "Pricing", "FAQ"], word_count: 1200 }),
      [stats("booking software", { position: 12, impressions: 200, clicks: 3, ctr: 0.015 })],
    );
    expect(out.map((d) => d.opportunity)).toContain("content_gap");
  });

  it("content_gap: ranks but short", () => {
    const out = run(page({ word_count: 700 }), [stats("booking software", { position: 12, impressions: 200 })]);
    expect(out.map((d) => d.opportunity)).toContain("content_gap");
  });

  it("content_gap does not fire when headings are unknown and the length is fine", () => {
    const out = run(page({ headings: null, word_count: 1200 }), [stats("booking software", { position: 12, impressions: 200 })]);
    expect(out.map((d) => d.opportunity)).not.toContain("content_gap");
  });

  it("thin: under 600 words with impressions, and content_gap steps aside", () => {
    const out = run(page({ word_count: 420 }), [stats("booking software", { position: 12, impressions: 200 })]);
    const kinds = out.map((d) => d.opportunity);
    expect(kinds).toContain("thin");
    expect(kinds).not.toContain("content_gap");
    expect(out.find((d) => d.opportunity === "thin")!.evidence.word_count).toBe(420);
  });

  it("thin does not fire without impressions: unmeasured is not zero", () => {
    expect(run(page({ word_count: 420 }), []).map((d) => d.opportunity)).not.toContain("thin");
  });

  it("a page with no keyword yields nothing", () => {
    expect(run(page({ keyword: null, word_count: 100 }), [stats("booking software", { position: 8, impressions: 500 })])).toEqual([]);
  });

  it("never writes 0 where nothing was measured", () => {
    const out = run(page({ word_count: null }), [stats("booking software", { position: 8, impressions: 500, clicks: 10, ctr: 0.02 })]);
    for (const d of out) {
      expect(d.evidence.word_count).toBeNull();
      expect(d.evidence.prev_position).toBeNull();
    }
  });
});

describe("expectedCtr", () => {
  it("falls with position and interpolates between integers", () => {
    expect(expectedCtr(1)).toBeGreaterThan(expectedCtr(2));
    expect(expectedCtr(2.5)).toBeCloseTo((expectedCtr(2) + expectedCtr(3)) / 2, 6);
    expect(expectedCtr(30)).toBe(expectedCtr(10));
  });
});

describe("headingMatchesQuery", () => {
  it("needs every significant term in one heading", () => {
    expect(headingMatchesQuery(["Best booking software for gyms"], "booking software")).toBe(true);
    expect(headingMatchesQuery(["Booking tips", "Software we like"], "booking software")).toBe(false);
    expect(headingMatchesQuery(["How to choose"], "how to")).toBe(true); // only stopwords: nothing to miss
  });
});

describe("headingsOf", () => {
  it("reads H1-H3 text and ignores deeper levels", () => {
    expect(headingsOf("<h1>A <em>b</em></h1><p>x</p><h2>C</h2><h4>D</h4><h3>E</h3>")).toEqual(["A b", "C", "E"]);
  });
});

describe("aggregateQueries", () => {
  it("sums clicks and impressions and weights position by impressions", () => {
    const m = aggregateQueries([
      { metric_date: "2026-08-01", query: "Booking Software", page_url: null, article_id: null, clicks: 10, impressions: 100, avg_position: "5.0" },
      { metric_date: "2026-08-02", query: "booking software", page_url: null, article_id: null, clicks: 0, impressions: 1, avg_position: 40 },
      // A page row, not a query row.
      { metric_date: "2026-08-02", query: null, page_url: "https://x/y", article_id: "a", clicks: 99, impressions: 99, avg_position: 1 },
    ]);
    const s = m.get("booking software")!;
    expect(s.clicks).toBe(10);
    expect(s.impressions).toBe(101);
    expect(s.position).toBeCloseTo((5 * 100 + 40 * 1) / 101, 6);
    expect(s.ctr).toBeCloseTo(10 / 101, 6);
    expect(m.size).toBe(1);
  });

  it("drops a query that never had a position", () => {
    const m = aggregateQueries([
      { metric_date: "2026-08-01", query: "q", page_url: null, article_id: null, clicks: 0, impressions: 5, avg_position: null },
    ]);
    expect(m.size).toBe(0);
  });
});

describe("splitWindows", () => {
  it("puts the last 28 days in current and the 28 before in previous", () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const { current, previous } = splitWindows(
      [
        { metric_date: "2026-09-03" },
        { metric_date: "2026-08-08" },
        { metric_date: "2026-08-06" },
        { metric_date: "2026-07-01" },
      ],
      now,
    );
    expect(current.map((r) => r.metric_date)).toEqual(["2026-09-03", "2026-08-08"]);
    expect(previous.map((r) => r.metric_date)).toEqual(["2026-08-06"]);
  });
});
