import { describe, it, expect, vi, beforeEach } from "vitest";
import { articleIndex, gscRowsForDay } from "@/lib/gsc/rows";

// ---------------------------------------------------------------------------
// One click, counted once
// ---------------------------------------------------------------------------
//
// `gscRowsForDay` writes four row shapes into `analytics_metrics` for a single
// day - property totals, one per query, one per page, one per (query, page) -
// and `lib/gsc/analysis.ts` says in as many words that they must never be
// summed together. Three readers did it anyway:
//
//   - the public share card's "Search clicks, 28 days", which filtered on
//     nothing at all and so read roughly 4x;
//   - the dashboard's "Est. traffic value", whose `.not("query","is",null)`
//     also matched the (query, page) shape, so ~2x;
//   - one article's traffic value, whose `.eq("article_id", …)` matched both
//     shapes that carry an article id, so ~2x.
//
// The stub below is deliberately minimal but it does honour the three
// operators the shape is expressed with - `eq`, `is`, `not(col,"is",null)` -
// because a stub that ignored them is exactly why the fixture next door
// (scope-fixture.ts, `.eq` only) could not have caught this.

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

function chain(rows: Row[]) {
  const filters: Filter[] = [];
  const q: Record<string, unknown> = {
    select: () => q,
    order: () => q,
    limit: () => q,
    in: (col: string, values: unknown[]) => {
      filters.push((r) => values.includes(r[col]));
      return q;
    },
    gte: () => q,
    ilike: () => q,
    eq: (col: string, value: unknown) => {
      filters.push((r) => r[col] === value);
      return q;
    },
    is: (col: string, value: unknown) => {
      filters.push((r) => (r[col] ?? null) === value);
      return q;
    },
    not: (col: string, op: string, value: unknown) => {
      if (op !== "is") throw new Error(`stub only knows not(col,"is",…), got ${op}`);
      filters.push((r) => (r[col] ?? null) !== value);
      return q;
    },
    maybeSingle: () => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: hit[0] ?? null, error: null });
    },
    then: (resolve: (v: { data: Row[]; count: number; error: null }) => unknown) => {
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      return resolve({ data: hit, count: hit.length, error: null });
    },
  };
  return q;
}

/** One day of Search Console, in every shape the sync writes. */
const DAY = gscRowsForDay({
  workspaceId: "w1",
  date: "2026-09-01",
  totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8 },
  queries: [
    { query: "alpha", clicks: 60, impressions: 600, ctr: 0.1, position: 7 },
    { query: "beta", clicks: 40, impressions: 400, ctr: 0.1, position: 9 },
  ],
  pages: [{ pageUrl: "https://x.test/a", clicks: 100, impressions: 1000, ctr: 0.1, position: 8 }],
  queryPages: [
    { query: "alpha", pageUrl: "https://x.test/a", clicks: 60, impressions: 600, ctr: 0.1, position: 7 },
    { query: "beta", pageUrl: "https://x.test/a", clicks: 40, impressions: 400, ctr: 0.1, position: 9 },
  ],
  articleIdByUrl: articleIndex([{ id: "art1", published_url: "https://x.test/a" }]),
}) as unknown as Row[];

// The whole point: the same 100 clicks appear four times over.
const ALL_SHAPES_SUM = DAY.reduce((s, r) => s + ((r.clicks as number) ?? 0), 0);

const TABLES: Record<string, Row[]> = {
  analytics_metrics: DAY,
  workspaces: [{ id: "w1", domain: "x.test", dr: 12, agency_id: "ag1", agencies: { remove_branding: false } }],
  articles: [{ id: "art1", workspace_id: "w1", status: "live" }],
  calendar_entries: [],
  workspace_integrations: [{ id: "i1", workspace_id: "w1", integration_id: "gsc" }],
  keywords: [{ workspace_id: "w1", term: "alpha", cpc: 2 }],
};

const db = { from: (table: string) => chain(TABLES[table] ?? []) };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => db,
  createServiceClient: () => db,
}));

beforeEach(() => vi.clearAllMocks());

describe("the sync writes one click four times", () => {
  it("is why an unfiltered sum is wrong", () => {
    expect(DAY).toHaveLength(6);
    expect(ALL_SHAPES_SUM).toBe(400);
  });
});

describe("share card clicks", () => {
  it("counts the property totals, not every shape", async () => {
    const { shareCardFactsWith } = await import("../share");
    const facts = await shareCardFactsWith(db as never, "w1");
    expect(facts?.clicks28d).toBe(100);
    expect(facts?.clicks28d).not.toBe(ALL_SHAPES_SUM);
  });
});

describe("traffic value", () => {
  it("prices query rows only, not query rows plus query-page rows", async () => {
    const { getTrafficValue } = await import("../value");
    const v = await getTrafficValue("w1");
    // The two query rows hold 60 + 40. Before the fix their (query, page)
    // twins were summed on top of them: 200 clicks, and a value to match.
    expect(v.clicks).toBe(100);
  });

  it("prices one article from its page rows only", async () => {
    const { getArticleValue } = await import("../value");
    const v = await getArticleValue("art1", "w1", "alpha");
    expect(v.clicks).toBe(100);
  });
});
