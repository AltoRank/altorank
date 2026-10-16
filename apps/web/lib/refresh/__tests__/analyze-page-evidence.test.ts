// analyzeWorkspace over the in-memory database: a candidate's evidence is the
// page's own Search Console numbers for its keyword, read from query_page rows.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase, type Row } from "@/lib/agent/__tests__/fake-supabase";
import { analyzeWorkspace } from "../detect";
import type { Evidence } from "../types";

const WS = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-15T06:00:00Z");
const day = (ago: number) => new Date(NOW.getTime() - ago * 86_400_000).toISOString().slice(0, 10);

let n = 0;
const metric = (over: Row): Row => ({ id: `m${n++}`, workspace_id: WS, source: "gsc", article_id: null, clicks: 0, impressions: 0, avg_position: null, page_url: null, query: null, ...over });

describe("analyzeWorkspace evidence", () => {
  it("attaches each page's own numbers, so two pages on one keyword differ, and labels them", async () => {
    const rows: Row[] = [];
    for (let ago = 1; ago <= 20; ago++) {
      // Site-wide: the query earns 400 impressions a day across both pages.
      rows.push(metric({ metric_date: day(ago), query: "booking software", clicks: 20, impressions: 400, avg_position: 4 }));
      rows.push(metric({ metric_date: day(ago), query: "booking software", page_url: "https://acme.com/a", clicks: 19, impressions: 300, avg_position: 2 }));
      rows.push(metric({ metric_date: day(ago), query: "booking software", page_url: "https://acme.com/b", clicks: 1, impressions: 100, avg_position: 9 }));
    }
    const db = fakeSupabase({
      workspace_integrations: [{ id: "wi", workspace_id: WS, integration_id: "gsc", tokens: { encrypted: "x" } }],
      analytics_metrics: rows,
      keywords: [],
      keyword_rankings: [],
      articles: [
        { id: "art-a", workspace_id: WS, status: "live", keyword: "booking software", word_count: 400, published_url: "https://acme.com/a" },
        { id: "art-b", workspace_id: WS, status: "live", keyword: "booking software", word_count: 400, published_url: "https://acme.com/b" },
      ],
      site_pages: [],
      refresh_candidates: [],
      workspaces: [{ id: WS }],
    });
    const r = await analyzeWorkspace(db as unknown as SupabaseClient, WS, { now: NOW, readBodies: async () => [] });
    expect(r.reason).toBe("ok");
    const evidence = (url: string) =>
      db.tables.refresh_candidates.filter((c) => c.url === url).map((c) => c.evidence as Evidence);
    const a = evidence("https://acme.com/a");
    const b = evidence("https://acme.com/b");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a[0]).toMatchObject({ impressions: 6000, clicks: 380, scope: "page" });
    expect(b[0]).toMatchObject({ impressions: 2000, clicks: 20, scope: "page" });
  });

  it("finds the page's own numbers when Google reports its URL with www and a trailing slash", async () => {
    const rows: Row[] = [];
    for (let ago = 1; ago <= 20; ago++) {
      rows.push(metric({ metric_date: day(ago), query: "booking software", clicks: 20, impressions: 400, avg_position: 4 }));
      rows.push(metric({ metric_date: day(ago), query: "booking software", page_url: "https://www.acme.com/a/", clicks: 2, impressions: 50, avg_position: 9 }));
    }
    const db = fakeSupabase({
      workspace_integrations: [{ id: "wi", workspace_id: WS, integration_id: "gsc", tokens: { encrypted: "x" } }],
      analytics_metrics: rows,
      keywords: [],
      keyword_rankings: [],
      articles: [{ id: "art-a", workspace_id: WS, status: "live", keyword: "booking software", word_count: 400, published_url: "https://acme.com/a" }],
      site_pages: [],
      refresh_candidates: [],
      workspaces: [{ id: WS }],
    });
    await analyzeWorkspace(db as unknown as SupabaseClient, WS, { now: NOW, readBodies: async () => [] });
    const evidence = db.tables.refresh_candidates.filter((c) => c.url === "https://acme.com/a").map((c) => c.evidence as Evidence);
    expect(evidence.length).toBeGreaterThan(0);
    // The page's 1,000 impressions, not the site's 8,000 under its name.
    expect(evidence[0]).toMatchObject({ impressions: 1000, clicks: 40, scope: "page" });
  });
});
