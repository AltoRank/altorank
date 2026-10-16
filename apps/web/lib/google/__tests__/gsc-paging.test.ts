// ---------------------------------------------------------------------------
// Search Analytics reports are read whole, not cut at a fixed row count
// ---------------------------------------------------------------------------
//
// Every report used to be one request with `rowLimit: 500` and no `startRow`.
// Google sorts by clicks, so on a site with more rows than that the low-click
// pages and queries were dropped, and the readers took a page missing from the
// stored rows as a page Google did not serve.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGSCDailyTotals, fetchGSCPageMetrics, fetchGSCQueryPageMetrics, SEARCH_ANALYTICS_MAX_PAGES, SEARCH_ANALYTICS_PAGE } from "../gsc";

type Body = { rowLimit: number; startRow: number; dimensions: string[] };

function stubGoogle(totalRows: number) {
  const bodies: Body[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Body;
    bodies.push(body);
    const count = Math.max(0, Math.min(body.rowLimit, totalRows - body.startRow));
    const rows = Array.from({ length: count }, (_, i) => ({
      keys: [`https://acme.com/p${body.startRow + i}`, `https://acme.com/p${body.startRow + i}`],
      clicks: 0,
      impressions: 1,
      ctr: 0,
      position: 40,
    }));
    return new Response(JSON.stringify({ rows }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("searchAnalytics paging", () => {
  it("asks for Google's largest page and keeps going until a page comes back short", async () => {
    const { bodies } = stubGoogle(SEARCH_ANALYTICS_PAGE + 1_200);
    const pages = await fetchGSCPageMetrics("token", "sc-domain:acme.com", "2026-10-01", "2026-10-01");
    expect(pages).toHaveLength(SEARCH_ANALYTICS_PAGE + 1_200);
    expect(bodies.map((b) => [b.rowLimit, b.startRow])).toEqual([
      [SEARCH_ANALYTICS_PAGE, 0],
      [SEARCH_ANALYTICS_PAGE, SEARCH_ANALYTICS_PAGE],
    ]);
  });

  it("keeps the rows past the 500th that the old fixed limit dropped", async () => {
    stubGoogle(1_800);
    const rows = await fetchGSCQueryPageMetrics("token", "sc-domain:acme.com", "2026-10-01", "2026-10-01");
    expect(rows).toHaveLength(1_800);
    expect(rows.at(-1)!.pageUrl).toBe("https://acme.com/p1799");
  });

  it("makes one request for a short report and one for the undimensioned total", async () => {
    const { fetchMock } = stubGoogle(3);
    await fetchGSCPageMetrics("token", "sc-domain:acme.com", "2026-10-01", "2026-10-01");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await fetchGSCDailyTotals("token", "sc-domain:acme.com", "2026-10-01");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at its page bound however many rows Google claims", async () => {
    const { fetchMock } = stubGoogle(Number.MAX_SAFE_INTEGER);
    await fetchGSCPageMetrics("token", "sc-domain:acme.com", "2026-10-01", "2026-10-01");
    expect(fetchMock).toHaveBeenCalledTimes(SEARCH_ANALYTICS_MAX_PAGES);
  });
});
