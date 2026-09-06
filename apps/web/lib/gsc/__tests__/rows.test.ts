import { describe, expect, it } from "vitest";
import { articleIndex, gscRowsForDay } from "../rows";
import { rowShape } from "../analysis";

const WS = "11111111-1111-4111-8111-111111111111";

describe("gscRowsForDay", () => {
  const rows = gscRowsForDay({
    workspaceId: WS,
    date: "2026-09-03",
    totals: { clicks: 12, impressions: 300, ctr: 0.04, position: 9.5 },
    queries: [{ query: "seo agency", clicks: 7, impressions: 100, ctr: 0.07, position: 6 }],
    pages: [
      { pageUrl: "https://www.a.co/blog/seo-agency/", clicks: 7, impressions: 100, ctr: 0.07, position: 6 },
      { pageUrl: "https://a.co/pricing", clicks: 5, impressions: 200, ctr: 0.025, position: 12 },
    ],
    queryPages: [
      { query: "seo agency", pageUrl: "https://a.co/blog/seo-agency", clicks: 7, impressions: 100, ctr: 0.07, position: 6 },
    ],
    articleIdByUrl: articleIndex([
      { id: "art-1", published_url: "https://a.co/blog/seo-agency" },
      { id: "art-2", published_url: null },
    ]),
  });

  it("writes one row per report line, each in its own shape", () => {
    expect(rows.map(rowShape)).toEqual(["total", "query", "page", "page", "query_page"]);
    for (const r of rows) {
      expect(r.workspace_id).toBe(WS);
      expect(r.source).toBe("gsc");
      expect(r.metric_date).toBe("2026-09-03");
    }
  });

  it("keeps the total with both keys null, so the series can find it", () => {
    expect(rows[0]).toMatchObject({ query: null, page_url: null, article_id: null, clicks: 12, impressions: 300, avg_position: 9.5 });
  });

  it("stores every page and names the article where one matches, spelling aside", () => {
    expect(rows[2]).toMatchObject({ page_url: "https://www.a.co/blog/seo-agency/", article_id: "art-1" });
    expect(rows[3]).toMatchObject({ page_url: "https://a.co/pricing", article_id: null });
    expect(rows[4]).toMatchObject({ query: "seo agency", page_url: "https://a.co/blog/seo-agency", article_id: "art-1" });
  });

  it("writes no total row when Google returned none for the day", () => {
    const none = gscRowsForDay({ workspaceId: WS, date: "2026-09-03", totals: null, queries: [], pages: [], queryPages: [], articleIdByUrl: new Map() });
    expect(none).toEqual([]);
  });
});
