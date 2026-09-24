// ---------------------------------------------------------------------------
// One click, counted once, by a real Postgres
// ---------------------------------------------------------------------------
//
// The unit tests prove what each reader asks for. Whether the answer is right
// is Postgres's business: which rows `query IS NULL` returns, whether a filter
// lets a second shape through, where PostgREST stops a response. So this seeds
// one day of Search Console exactly the way the nightly sync does - through
// gscRowsForDay, all four shapes - and asks the readers that shipped wrong
// numbers for theirs:
//
// - readGsc: every shape of the day holds the same 100 clicks. Summed across
//   shapes it is 400, which is the figure the client report printed.
// - the client report (lib/reports/metrics.ts): its Search Console block is
//   the day's total row, and its CTR is clicks over impressions. It summed all
//   four shapes and averaged the rows' CTRs until this change.
// - the article research layer (lib/seo/research.ts): "already ranking"
//   carries the query row's numbers. It read query_page rows as more of the
//   same query, which doubled them.
//
// And one read the cap used to cut short: 2,500 rows come back as 2,500.
//
// Every row hangs off one account with a random slug; deleting the account
// cascades to its workspaces and their metrics, so the shared local stack is
// left as it was found.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { aggregateReportData } from "@/lib/reports/metrics";
import { fetchGscSignals } from "@/lib/seo/research";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import { ROW_SHAPES } from "../analysis";
import { GSC_PAGE_SIZE, readGsc } from "../read";
import { gscRowsForDay } from "../rows";

const STACK = await connectLocalStack();
const TAG = randomUUID().slice(0, 8);

/** ISO date `n` days before now, UTC: inside every lookback the readers use. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const DAY = daysAgo(1);

/**
 * One day, as Google reports it in four dimensions. Each dimension accounts
 * for the same 100 clicks and 1,000 impressions: that is what makes a sum
 * across two of them wrong. The rows' own CTRs differ (20%, 5.7%, 17.5%, ...)
 * so that their mean, about 11.7%, is visibly not the day's 10%.
 */
function oneDay(workspaceId: string) {
  const a = `https://db-proof-${TAG}.test/a`;
  const b = `https://db-proof-${TAG}.test/b`;
  return gscRowsForDay({
    workspaceId,
    date: DAY,
    totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8 },
    queries: [
      { query: "alpha widget", clicks: 60, impressions: 300, ctr: 0.2, position: 7 },
      { query: "beta widget", clicks: 40, impressions: 700, ctr: 0.0571, position: 9.5 },
    ],
    pages: [
      { pageUrl: a, clicks: 70, impressions: 400, ctr: 0.175, position: 7.5 },
      { pageUrl: b, clicks: 30, impressions: 600, ctr: 0.05, position: 9 },
    ],
    queryPages: [
      { query: "alpha widget", pageUrl: a, clicks: 60, impressions: 300, ctr: 0.2, position: 7 },
      { query: "beta widget", pageUrl: a, clicks: 10, impressions: 100, ctr: 0.1, position: 11 },
      { query: "beta widget", pageUrl: b, clicks: 30, impressions: 600, ctr: 0.05, position: 9 },
    ],
    articleIdByUrl: new Map(),
  });
}

const sum = (rows: Array<{ clicks: number | null }>) => rows.reduce((s, r) => s + (r.clicks ?? 0), 0);

describe.skipIf(!STACK)("Search Console reads on the local stack", () => {
  let db: ReturnType<typeof createServiceClient>;
  let accountId: string;
  /** One seeded day in all four shapes. */
  let dayWs: string;
  /** 2,500 query rows. */
  let bulkWs: string;

  async function workspace(label: string): Promise<string> {
    const { data, error } = await db
      .from("workspaces")
      .insert({
        account_id: accountId,
        name: `GSC ${label} ${TAG}`,
        domain: `gsc-${label}-${TAG}.test`,
        initials: "GS",
        color: "av-c1",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`workspaces: ${error?.message}`);
    return data.id as string;
  }

  beforeAll(async () => {
    db = createServiceClient();
    const { data: account, error } = await db
      .from("accounts")
      .insert({ name: `GSC proof ${TAG}`, slug: `gsc-proof-${TAG}` })
      .select("id")
      .single();
    if (error || !account) throw new Error(`accounts: ${error?.message}`);
    accountId = account.id as string;
    dayWs = await workspace("day");
    bulkWs = await workspace("bulk");

    const { error: dayErr } = await db.from("analytics_metrics").insert(oneDay(dayWs));
    if (dayErr) throw new Error(`analytics_metrics (day): ${dayErr.message}`);
    // Priced, so the report's organic value has a term to price.
    const { error: kwErr } = await db.from("keywords").insert({ workspace_id: dayWs, term: "alpha widget", cpc: 2 });
    if (kwErr) throw new Error(`keywords: ${kwErr.message}`);

    // 25 days of 100 queries: 2,500 query rows, the shape the 90-day readers
    // read, two and a half times PostgREST's cap.
    const bulk = Array.from({ length: 25 }, (_, d) =>
      gscRowsForDay({
        workspaceId: bulkWs,
        date: daysAgo(d + 1),
        totals: null,
        queries: Array.from({ length: 100 }, (_, q) => ({ query: `bulk query ${q}`, clicks: 1, impressions: 10, ctr: 0.1, position: 12 })),
        pages: [],
        queryPages: [],
        articleIdByUrl: new Map(),
      }),
    ).flat();
    for (let i = 0; i < bulk.length; i += 500) {
      const { error: bulkErr } = await db.from("analytics_metrics").insert(bulk.slice(i, i + 500));
      if (bulkErr) throw new Error(`analytics_metrics (bulk): ${bulkErr.message}`);
    }
  }, 60_000);

  afterAll(async () => {
    // Accounts cascade to workspaces; workspaces to keywords and metrics.
    if (db && accountId) await db.from("accounts").delete().eq("id", accountId);
  }, 60_000);

  it("seeds what the sync writes: one day, four shapes, 400 clicks in all", async () => {
    // The raw table, read the way the old readers read it (every Search
    // Console row in the day, no shape filter): this is the 4x.
    const { data } = await db.from("analytics_metrics").select("clicks").eq("workspace_id", dayWs).eq("source", "gsc");
    expect(sum(data ?? [])).toBe(400);
  });

  it("readGsc: every shape of the day is the same 100 clicks, never 400", async () => {
    const gsc = await readGsc(db, { workspaceId: dayWs, shapes: ROW_SHAPES, since: DAY, until: DAY, columns: ["clicks", "impressions"] });
    expect(Object.fromEntries(ROW_SHAPES.map((s) => [s, gsc[s].length]))).toEqual({ total: 1, query: 2, page: 2, query_page: 3 });
    for (const shape of ROW_SHAPES) {
      expect(sum(gsc[shape]), shape).toBe(100);
      expect(gsc[shape].reduce((s, r) => s + (r.impressions ?? 0), 0), shape).toBe(1000);
    }
    // And each row is where its columns say it belongs.
    expect(gsc.total.every((r) => r.query === null && r.page_url === null)).toBe(true);
    expect(gsc.query.every((r) => r.query !== null && r.page_url === null)).toBe(true);
    expect(gsc.page.every((r) => r.query === null && r.page_url !== null)).toBe(true);
    expect(gsc.query_page.every((r) => r.query !== null && r.page_url !== null)).toBe(true);
  });

  it("the client report's Search Console block is the total shape, with CTR as clicks over impressions", async () => {
    const report = await aggregateReportData(db, dayWs, DAY, DAY);
    expect(report.gscSummary).toEqual({ clicks: 100, impressions: 1000, ctr: 0.1 });
    // The organic value prices the query shape: 100 clicks, 60 of them on the
    // one priced term at 2 a click. Query + query_page would be 200 and 240.
    expect(report.organicValue).toMatchObject({ clicks: 100, valuedClicks: 60, value: 120 });
  });

  it("the research layer's existing performance is the query shape", async () => {
    const signals = await fetchGscSignals(db, dayWs, "alpha widget");
    expect(signals.layer.status).toBe("ok");
    expect(signals.existing).toEqual({ query: "alpha widget", clicks: 60, impressions: 300, position: 7 });
  });

  it("the local PostgREST caps an unpaged read at 1,000 rows, so the next test means something", async () => {
    const { data } = await db.from("analytics_metrics").select("id").eq("workspace_id", bulkWs);
    expect(data).toHaveLength(GSC_PAGE_SIZE);
  });

  it("readGsc: 2,500 seeded rows come back as 2,500, each once", async () => {
    const gsc = await readGsc(db, { workspaceId: bulkWs, shapes: ["query"], since: daysAgo(30), columns: ["id", "clicks"] });
    expect(gsc.query).toHaveLength(2500);
    expect(new Set(gsc.query.map((r) => r.id)).size).toBe(2500);
    expect(sum(gsc.query)).toBe(2500);
  });
});
