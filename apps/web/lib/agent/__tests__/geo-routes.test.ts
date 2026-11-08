/**
 * The AI-visibility routes of the agent API: real auth and handlers, the
 * in-memory fake for the database, and the plan gate stubbed so a test can
 * say "this account has no plan".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/agent/api-keys";
import { fakeSupabase, type FakeSupabase } from "./fake-supabase";

let db: FakeSupabase;
let entitled = true;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => db,
  createClient: async () => db,
}));
vi.mock("@/lib/billing/quota", () => ({
  getQuota: async () => ({ reason: entitled ? "plan" : "no-plan" }),
  entitledToScheduledWork: (q: { reason: string }) => q.reason !== "no-plan",
}));

const ACCOUNT = "account-1";
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const WRITE_KEY = "altorank_live_" + "W".repeat(40);
const READ_KEY = "altorank_live_" + "R".repeat(40);
const RUN = "77777777-7777-4777-8777-777777777777";

function request(path: string, opts: { key?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? WRITE_KEY}` };
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3132/api/agent/v1${path}`, {
    method: opts.json !== undefined ? "POST" : "GET",
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
}

beforeEach(() => {
  entitled = true;
  const now = new Date().toISOString();
  db = fakeSupabase({
    api_keys: [
      { id: "key-write", account_id: ACCOUNT, name: "writer", scopes: ["read", "write"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(WRITE_KEY) },
      { id: "key-read", account_id: ACCOUNT, name: "reader", scopes: ["read"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(READ_KEY) },
    ],
    workspaces: [
      { id: WS, account_id: ACCOUNT, name: "Acme", domain: "acme.com", status: "on", geo_tracking: false, created_at: now },
      { id: OTHER_WS, account_id: "account-2", name: "Not ours", domain: "other.com", status: "on", geo_tracking: false, created_at: now },
    ],
    geo_prompts: [{ id: "p-1", workspace_id: WS, prompt: "free backlink checker", enabled: true, created_at: now }],
    geo_runs: [],
    geo_results: [],
  });
});

describe("POST /geo/prompts", () => {
  it("refuses a read-only key and writes nothing", async () => {
    const { POST } = await import("@/app/api/agent/v1/geo/prompts/route");
    const res = await POST(request("/geo/prompts", { key: READ_KEY, json: { workspace_id: WS, add: ["seo tool"] } }));
    expect(res.status).toBe(403);
    expect(db.tables.geo_prompts).toHaveLength(1);
  });

  it("removes by exact text, then adds, normalising whitespace", async () => {
    const { POST } = await import("@/app/api/agent/v1/geo/prompts/route");
    const res = await POST(request("/geo/prompts", { json: { workspace_id: WS, remove: ["Free Backlink Checker"], add: ["  best   seo tool "] } }));
    const env = await res.json();
    expect(env.ok).toBe(true);
    expect(env.data.removed).toEqual(["free backlink checker"]);
    expect(env.data.added).toEqual(["best seo tool"]);
    expect(db.tables.geo_prompts.map((p) => p.prompt)).toEqual(["best seo tool"]);
  });

  it("will not touch another account's site", async () => {
    const { POST } = await import("@/app/api/agent/v1/geo/prompts/route");
    const res = await POST(request("/geo/prompts", { json: { workspace_id: OTHER_WS, add: ["seo tool"] } }));
    expect(res.status).toBe(404);
    expect(db.tables.geo_prompts).toHaveLength(1);
  });
});

describe("POST /geo/tracking", () => {
  it("switches tracking on for an account with a plan", async () => {
    const { POST } = await import("@/app/api/agent/v1/geo/tracking/route");
    const res = await POST(request("/geo/tracking", { json: { workspace_id: WS, enabled: true } }));
    expect((await res.json()).ok).toBe(true);
    expect(db.tables.workspaces.find((w) => w.id === WS)!.geo_tracking).toBe(true);
  });

  it("refuses to switch on without a plan, and still allows switching off", async () => {
    entitled = false;
    const { POST } = await import("@/app/api/agent/v1/geo/tracking/route");
    const on = await POST(request("/geo/tracking", { json: { workspace_id: WS, enabled: true } }));
    expect(on.status).toBe(403);
    expect(db.tables.workspaces.find((w) => w.id === WS)!.geo_tracking).toBe(false);
    const off = await POST(request("/geo/tracking", { json: { workspace_id: WS, enabled: false } }));
    expect((await off.json()).ok).toBe(true);
  });
});

describe("GET /geo/visibility", () => {
  it("says 'not tracked' rather than reporting a rate when there is no sweep", async () => {
    const { GET } = await import("@/app/api/agent/v1/geo/visibility/route");
    const env = await (await GET(request(`/geo/visibility?workspace_id=${WS}`, { key: READ_KEY }))).json();
    expect(env.ok).toBe(true);
    expect(env.data.run).toBeNull();
    expect(env.agent_guidance).toMatch(/not tracked/);
  });

  it("reports the rate with its range from the latest sweep's answers only", async () => {
    const at = new Date().toISOString();
    db.tables.geo_runs.push({ id: RUN, workspace_id: WS, status: "complete", planned: 3, captured: 2, failed: 1, settings: { surfaces: ["chat_gpt"], samples: 1 }, cost_usd: 0.0036, started_at: at, finished_at: at });
    const row = (over: Record<string, unknown>) => ({ workspace_id: WS, run_id: RUN, prompt: "free backlink checker", engine: "chat_gpt", status: "ok", model: "gpt", answer: "", mentioned: false, cited: false, citations: [], competitor_domains: [], brands: [], fan_out_queries: [], cost_usd: 0.0012, error: null, checked_at: at, ...over });
    db.tables.geo_results.push(
      row({ id: "r1", mentioned: true, brands: ["Ahrefs"] }),
      row({ id: "r2", brands: ["Ahrefs"] }),
      row({ id: "r3", status: "failed", error: "timeout" }),
    );
    const { GET } = await import("@/app/api/agent/v1/geo/visibility/route");
    const env = await (await GET(request(`/geo/visibility?workspace_id=${WS}`, { key: READ_KEY }))).json();
    expect(env.data.answers).toBe(2);
    expect(env.data.mention_rate_pct).toBe(50);
    expect(env.data.mention_range_95_pct.low).toBeGreaterThan(0);
    expect(env.data.named_instead[0]).toMatchObject({ brand: "Ahrefs", answers: 2 });
    expect(env.agent_guidance).toMatch(/95% range/);
  });
});
