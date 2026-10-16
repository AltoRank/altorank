/**
 * The Search Console agent routes, state by state: what a connection that is
 * refused, failing, quiet or stale says, through the real handlers and auth
 * over the in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/agent/api-keys";
import { fakeSupabase, type FakeSupabase, type Row } from "./fake-supabase";

let db: FakeSupabase;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => db,
  createClient: async () => db,
}));

const ACCOUNT = "account-1";
const WS = "11111111-1111-4111-8111-111111111111";
const ART = "33333333-3333-4333-8333-333333333333";
const KEY = "altorank_live_" + "G".repeat(40);
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

function setup(opts: { integration?: Row; metrics?: Row[]; articles?: Row[]; sitePages?: Row[] } = {}) {
  const now = new Date().toISOString();
  db = fakeSupabase({
    api_keys: [{ id: "key", account_id: ACCOUNT, name: "k", scopes: ["read"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(KEY) }],
    workspaces: [{ id: WS, account_id: ACCOUNT, name: "Acme", domain: "acme.com", status: "on", paused_meta: null, paused_until: null, created_at: now }],
    workspace_integrations: [
      {
        id: "wi-gsc",
        workspace_id: WS,
        integration_id: "gsc",
        connected_at: now,
        config: { gscSiteUrl: "sc-domain:acme.com" },
        needs_reconnect: false,
        last_sync_error: null,
        last_synced_at: null,
        synced_from: null,
        synced_through: null,
        ...opts.integration,
      },
    ],
    analytics_metrics: opts.metrics ?? [],
    articles: opts.articles ?? [],
    site_pages: opts.sitePages ?? [],
  });
}

function get(path: string) {
  return new NextRequest(`http://localhost:3132/api/agent/v1${path}`, { headers: { authorization: `Bearer ${KEY}` } });
}

const ROUTES = {
  performance: () => import("@/app/api/agent/v1/gsc/performance/route"),
  cannibalization: () => import("@/app/api/agent/v1/gsc/cannibalization/route"),
  coverage: () => import("@/app/api/agent/v1/gsc/coverage/route"),
  "url-inspection": () => import("@/app/api/agent/v1/gsc/url-inspection/route"),
};

async function call(route: keyof typeof ROUTES, query = "") {
  const mod = await ROUTES[route]();
  const res: Response = await mod.GET(get(`/gsc/${route}?workspace_id=${WS}${query}`));
  return { status: res.status, env: await res.json() };
}

const metric = (date: string, over: Row = {}): Row => ({
  id: `m-${date}-${Math.random()}`,
  workspace_id: WS,
  source: "gsc",
  metric_date: date,
  clicks: 3,
  impressions: 30,
  avg_position: 8,
  page_url: null,
  query: null,
  article_id: null,
  created_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => setup());

describe("a connection that cannot sync", () => {
  it("refuses with a reconnect instruction when Google refused the token, on every route", async () => {
    setup({ integration: { needs_reconnect: true, last_sync_error: "invalid_grant" }, metrics: [metric(iso(40))] });
    for (const route of ["performance", "cannibalization", "coverage"] as const) {
      const { status, env } = await call(route);
      expect(status).toBe(409);
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe("not_available");
      expect(env.agent_guidance).toMatch(/reconnect Google/);
      expect(env.agent_guidance).not.toMatch(/connection is new/);
    }
    expect((await call("url-inspection", "&url=https://acme.com/a")).status).toBe(409);
  });

  it("names the stored error when no sync has ever succeeded, instead of calling the connection new", async () => {
    const error = "This Google account has no Search Console property for acme.com. It can see: none.";
    setup({ integration: { config: { type: "gsc" }, last_sync_error: error } });
    const { status, env } = await call("performance");
    expect(status).toBe(409);
    expect(env.error.message).toMatch(/no sync has succeeded/);
    expect(env.agent_guidance).toContain(error);
    expect(env.agent_guidance).not.toMatch(/connection is new/);
  });
});

describe("connected, nothing stored", () => {
  it("calls a connection new only while it is", async () => {
    const { env } = await call("performance");
    expect(env.ok).toBe(true);
    expect(env.data.has_data).toBe(false);
    expect(env.agent_guidance).toMatch(/connection is new/);
  });

  it("does not call a month-old connection with nothing stored new", async () => {
    setup({ integration: { connected_at: new Date(Date.now() - 30 * DAY).toISOString() } });
    const { env } = await call("performance");
    expect(env.data.has_data).toBe(false);
    expect(env.agent_guidance).not.toMatch(/connection is new/);
    expect(env.agent_guidance).toMatch(/connected since/);
    expect(env.agent_guidance).toMatch(/do not report zero/i);
  });

  it("reports a measured zero when the sync answered for the window and Google had nothing", async () => {
    setup({
      integration: { connected_at: new Date(Date.now() - 30 * DAY).toISOString(), last_synced_at: new Date().toISOString(), synced_from: iso(37), synced_through: iso(3) },
    });
    const perf = await call("performance");
    expect(perf.env.ok).toBe(true);
    expect(perf.env.data.has_data).toBe(true);
    expect(perf.env.data.clicks.current).toBe(0);
    expect(perf.env.data.sync.synced_through).toBe(iso(3));
    expect(perf.env.agent_guidance).toMatch(/no impressions/);
    expect(perf.env.agent_guidance).not.toMatch(/not in yet/);

    const cann = await call("cannibalization");
    expect(cann.env.data.has_data).toBe(true);
    expect(cann.env.agent_guidance).toMatch(/No cannibalisation found/);
  });
});

describe("a sync that failed after earlier ones stored data", () => {
  it("serves the numbers and says they may be behind", async () => {
    setup({ integration: { last_sync_error: "GSC API error (503): backend error" }, metrics: [metric(iso(5))] });
    const { env } = await call("performance");
    expect(env.ok).toBe(true);
    expect(env.data.has_data).toBe(true);
    expect(env.agent_guidance).toMatch(/most recent sync failed/);
  });
});

describe("the change against the previous window", () => {
  const daily = (from: number, to: number, clicks: number) => {
    const out: Row[] = [];
    for (let ago = from; ago >= to; ago--) out.push(metric(iso(ago), { clicks, impressions: clicks * 10 }));
    return out;
  };

  it("states none for a connection read 22 days later, whose history starts a week before the connect", async () => {
    setup({
      integration: { connected_at: new Date(Date.now() - 22 * DAY).toISOString(), synced_from: iso(29), synced_through: iso(3) },
      metrics: daily(29, 3, 10),
    });
    const { env } = await call("performance");
    expect(env.data.has_data).toBe(true);
    expect(env.data.comparable).toBe(false);
    expect(env.data.clicks.changePct).toBeNull();
    expect(env.data.clicks.previous).toBeNull();
    expect(env.agent_guidance).toMatch(/not whole/);
    expect(env.agent_guidance).not.toMatch(/%/);
  });

  it("ends both windows on the newest synced day and compares them once both are whole", async () => {
    setup({
      integration: { connected_at: new Date(Date.now() - 90 * DAY).toISOString(), synced_from: iso(80), synced_through: iso(3) },
      metrics: [...daily(58, 31, 10), ...daily(30, 3, 12)],
    });
    const { env } = await call("performance");
    expect(env.data.window.current.end).toBe(iso(3));
    expect(env.data.window.previous.end).toBe(iso(31));
    expect(env.data.comparable).toBe(true);
    expect(env.data.clicks).toEqual({ current: 336, previous: 280, changePct: 20 });
    expect(env.agent_guidance).toMatch(/\+20% vs the 28 days before/);
  });
});

describe("url-inspection and coverage against the stored verdict", () => {
  const URL = "https://acme.com/post";
  const article = (inspection: Row): Row => ({
    id: ART,
    workspace_id: WS,
    title: "Post",
    status: "live",
    published_url: URL,
    indexing_status: { inspection: { verdict: null, coverageState: null, checkedAt: new Date(Date.now() - 20 * DAY).toISOString(), ...inspection } },
  });
  const servedRow = (ago: number) => metric(iso(ago), { page_url: URL, impressions: 6, clicks: 1 });

  it("says indexed, and that the verdict is out of date, when the page was served after a not-indexed inspection", async () => {
    setup({ articles: [article({ verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed" })], metrics: [servedRow(4)] });
    const { env } = await call("url-inspection", `&url=${encodeURIComponent(URL)}`);
    expect(env.data.bucket).toBe("indexed");
    expect(env.data.served_in_search).toBe(true);
    expect(env.data.inspection_superseded).toBe(true);
    expect(env.data.last_served_in_search).toBe(iso(4));
    expect(env.agent_guidance).toMatch(/out of date/);
    expect(env.agent_guidance).not.toMatch(/Not in the index/);

    const cov = await call("coverage");
    expect(cov.env.data.summary).toMatchObject({ indexed: 1, not_indexed: 0 });
    expect(cov.env.data.pages[0]).toMatchObject({ bucket: "indexed", inspection_superseded: true });
  });

  it("keeps a not-indexed verdict that no later search evidence overtakes", async () => {
    setup({ articles: [article({ verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" })], metrics: [servedRow(25)] });
    const { env } = await call("url-inspection", `&url=${encodeURIComponent(URL)}&days=90`);
    expect(env.data.bucket).toBe("not_indexed");
    expect(env.agent_guidance).toMatch(/Not in the index/);
  });

  it("does not call a PARTIAL verdict on an unserved page indexed", async () => {
    setup({ articles: [article({ verdict: "PARTIAL", coverageState: "Indexed, though blocked by robots.txt" })], metrics: [metric(iso(5))] });
    const { env } = await call("url-inspection", `&url=${encodeURIComponent(URL)}`);
    expect(env.data.bucket).toBe("unknown");
    expect(env.data.served_in_search).toBe(false);
    expect(env.agent_guidance).toMatch(/unknown/);
    expect(env.agent_guidance).not.toMatch(/Indexed\. If/);
  });
});
