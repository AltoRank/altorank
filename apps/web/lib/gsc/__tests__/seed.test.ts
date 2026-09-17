// ---------------------------------------------------------------------------
// Search Console queries reach the keyword pool
// ---------------------------------------------------------------------------
//
// altorank.co held "rankingcoach alternative" at 215 impressions / position 28
// in analytics_metrics and never wrote to it, because nothing turned a query
// into a keyword row. These pin the selection rules and the write.

import { describe, it, expect } from "vitest";
import { selectSearchConsoleSeeds, seedKeywordsFromSearchConsole, type QueryRow } from "../seed";
import { fakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";

const q = (query: string, impressions: number, avg_position: number, extra?: Partial<QueryRow>): QueryRow => ({
  query,
  page_url: null,
  impressions,
  clicks: 0,
  avg_position,
  ...extra,
});

describe("selectSearchConsoleSeeds", () => {
  const domain = "altorank.co";

  it("keeps a striking-distance query the site already appears for", () => {
    const { seeds } = selectSearchConsoleSeeds([q("rankingcoach alternative", 215, 28)], domain);
    expect(seeds).toEqual([{ term: "rankingcoach alternative", impressions: 215, clicks: 0, position: 28 }]);
  });

  it("aggregates a query across days, impression-weighted for position", () => {
    // 100 impressions at 30 and 10 at 3: the month at 30 wins, the day at 3 nudges.
    const { seeds } = selectSearchConsoleSeeds([q("geo pricing", 100, 30), q("geo pricing", 10, 3)], domain);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].impressions).toBe(110);
    expect(seeds[0].position).toBe(28);
  });

  it("reads the query shape only, never query_page rows", () => {
    // The same impressions again, once per page: counting both doubles them.
    const rows = [q("geo pricing", 50, 20), q("geo pricing", 50, 20, { page_url: "https://altorank.co/geo/" })];
    const { seeds } = selectSearchConsoleSeeds(rows, domain);
    expect(seeds[0].impressions).toBe(50);
  });

  it("drops brand navigation but keeps an evaluative brand query", () => {
    // The house rule from keyword-research/seeds.ts: "altorank" is someone
    // who knows the name; "altorank pricing" is someone deciding.
    const { seeds, brand } = selectSearchConsoleSeeds([q("altorank", 400, 1), q("altorank pricing", 40, 2)], domain);
    expect(seeds.map((s) => s.term)).toEqual(["altorank pricing"]);
    expect(brand).toBe(1);
  });

  it("drops noise under the impression floor and past the position ceiling", () => {
    const { seeds, weak } = selectSearchConsoleSeeds([q("serp analyzer", 9, 12), q("keyword cluster", 80, 91)], domain);
    expect(seeds).toEqual([]);
    expect(weak).toBe(2);
  });

  it("orders by measured demand and respects the limit", () => {
    const rows = [q("a", 20, 15), q("b", 200, 15), q("c", 50, 15)];
    const { seeds } = selectSearchConsoleSeeds(rows, domain, { limit: 2 });
    expect(seeds.map((s) => s.term)).toEqual(["b", "c"]);
  });
});

describe("seedKeywordsFromSearchConsole", () => {
  const ws = { id: "ws1", domain: "altorank.co", language: "en" };
  const now = new Date("2026-09-17T04:00:00Z");
  const metric = (query: string, impressions: number, avg_position: number, metric_date = "2026-09-10") => ({
    workspace_id: "ws1",
    source: "gsc",
    metric_date,
    query,
    page_url: null,
    impressions,
    clicks: 0,
    avg_position,
  });

  it("writes a keyword row and a ranking row per new query", async () => {
    const db = fakeDb({ analytics_metrics: [metric("rankingcoach alternative", 215, 28)], keywords: [], keyword_rankings: [] });
    const r = await seedKeywordsFromSearchConsole(db.client, ws, { now });
    expect(r.inserted).toBe(1);
    expect(r.terms).toEqual(["rankingcoach alternative"]);
    const kw = db.tables.keywords[0];
    expect(kw).toMatchObject({ workspace_id: "ws1", term: "rankingcoach alternative", source: "gsc", status: "new", volume: null });
    expect(db.tables.keyword_rankings[0]).toMatchObject({ position: 28 });
  });

  it("refreshes the position of a term it stored on an earlier run", async () => {
    const db = fakeDb({
      analytics_metrics: [metric("rankingcoach alternative", 300, 21, "2026-09-15")],
      keywords: [{ id: "k1", workspace_id: "ws1", term: "rankingcoach alternative", source: "gsc" }],
      keyword_rankings: [{ keyword_id: "k1", position: 28, checked_at: "2026-09-01T00:00:00Z" }],
    });
    const r = await seedKeywordsFromSearchConsole(db.client, ws, { now });
    expect(r.inserted).toBe(0);
    expect(r.refreshed).toBe(1);
    expect(db.tables.keyword_rankings).toHaveLength(2);
    expect(db.tables.keyword_rankings[1]).toMatchObject({ keyword_id: "k1", position: 21 });
  });

  it("does not touch the position of a term another source owns", async () => {
    const db = fakeDb({
      analytics_metrics: [metric("rankingcoach alternative", 300, 21)],
      keywords: [{ id: "k1", workspace_id: "ws1", term: "rankingcoach alternative", source: "ideas" }],
      keyword_rankings: [],
    });
    const r = await seedKeywordsFromSearchConsole(db.client, ws, { now });
    expect(r.refreshed).toBe(0);
    expect(db.tables.keyword_rankings).toHaveLength(0);
  });

  it("leaves a term already in the pool alone, from any source", async () => {
    const db = fakeDb({
      analytics_metrics: [metric("rankingcoach alternative", 215, 28)],
      keywords: [{ id: "k1", workspace_id: "ws1", term: "RankingCoach Alternative", source: "ideas" }],
      keyword_rankings: [],
    });
    const r = await seedKeywordsFromSearchConsole(db.client, ws, { now });
    expect(r.inserted).toBe(0);
    expect(r.existing).toBe(1);
    expect(db.tables.keywords).toHaveLength(1);
  });

  it("ignores rows outside the lookback window", async () => {
    const db = fakeDb({ analytics_metrics: [metric("rankingcoach alternative", 215, 28, "2026-05-01")], keywords: [], keyword_rankings: [] });
    const r = await seedKeywordsFromSearchConsole(db.client, ws, { now });
    expect(r.inserted).toBe(0);
    expect(r.detail).toMatch(/no Search Console queries/);
  });

  it("says so when the workspace has no domain", async () => {
    const db = fakeDb({});
    const r = await seedKeywordsFromSearchConsole(db.client, { id: "ws1", domain: null }, { now });
    expect(r.inserted).toBe(0);
    expect(r.detail).toMatch(/no domain/);
  });
});
