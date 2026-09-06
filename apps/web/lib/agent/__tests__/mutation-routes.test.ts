/**
 * The mutation routes end to end: real auth, real handlers, a fake database.
 *
 * `@/lib/supabase/server` is mocked so `createServiceClient()` hands back the
 * in-memory fake; everything above it - key hashing, scope check, envelope,
 * the shared cores in lib/plan, lib/workspaces, lib/agent/replace - is the
 * production code. Each test seeds its own rows and asserts on `writes`, so
 * "preview wrote nothing" is a fact about the database, not about a flag.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/agent/api-keys";
import { fakeSupabase, type FakeSupabase, type Seed } from "./fake-supabase";

let db: FakeSupabase;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => db,
  createClient: async () => db,
}));

const AGENCY = "agency-1";
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const ART_REVIEW = "33333333-3333-4333-8333-333333333333";
const ART_APPROVED = "44444444-4444-4444-8444-444444444444";
const ART_OTHER = "55555555-5555-4555-8555-555555555555";
const KW_PLANNED = "66666666-6666-4666-8666-666666666666";

const WRITE_KEY = "altorank_live_" + "W".repeat(40);
const READ_KEY = "altorank_live_" + "R".repeat(40);

const body = (title: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: `${title} is built by Acme. Acme ships weekly.` }] }],
});

function seed(extra: Partial<Seed> = {}): Seed {
  const now = new Date().toISOString();
  return {
    api_keys: [
      { id: "key-write", agency_id: AGENCY, name: "writer", scopes: ["read", "generate", "write"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(WRITE_KEY) },
      { id: "key-read", agency_id: AGENCY, name: "reader", scopes: ["read", "generate"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(READ_KEY) },
    ],
    workspaces: [
      { id: WS, agency_id: AGENCY, name: "Acme", domain: "acme.com", status: "on", paused_meta: null, paused_until: null, auto_generate_weekly_limit: 2, language: "en", location_code: 2840, created_at: now },
      { id: OTHER_WS, agency_id: "agency-2", name: "Not ours", domain: "other.com", status: "on", paused_meta: null, paused_until: null, created_at: now },
    ],
    articles: [
      { id: ART_REVIEW, workspace_id: WS, title: "Acme guide", slug: "acme-guide", keyword: "acme", status: "review", content: body("Acme guide"), word_count: 9, seo_score: 70, created_at: now, updated_at: now },
      { id: ART_APPROVED, workspace_id: WS, title: "Approved Acme", slug: "approved", keyword: "acme", status: "approved", approved_by: "u1", content: body("Approved Acme"), created_at: now, updated_at: now },
      { id: ART_OTHER, workspace_id: OTHER_WS, title: "Theirs", slug: "theirs", keyword: "x", status: "review", content: body("Theirs"), created_at: now, updated_at: now },
    ],
    keywords: [{ id: KW_PLANNED, workspace_id: WS, term: "acme widgets", status: "planned", plan_excluded_at: null, created_at: now }],
    calendar_entries: [{ id: "e-1", workspace_id: WS, keyword_id: KW_PLANNED, keyword: "acme widgets", article_id: null, scheduled_date: "2026-10-01", status: "queue" }],
    publish_log: [],
    workspace_integrations: [],
    analytics_metrics: [],
    ...extra,
  };
}

function request(path: string, opts: { method?: "GET" | "POST"; key?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? WRITE_KEY}` };
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3132/api/agent/v1${path}`, {
    method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
}

const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

/** Writes to anything but the key's own last_used_at bookkeeping. */
const dataWrites = () => db.writes.filter((w) => w.table !== "api_keys");

beforeEach(() => {
  db = fakeSupabase(seed());
});

describe("scope guard", () => {
  it("refuses every mutation to a key without the write scope, with guidance naming the scope", async () => {
    const { POST: bulkRemove } = await import("@/app/api/agent/v1/keywords/bulk-remove/route");
    const res = await bulkRemove(request("/keywords/bulk-remove", { key: READ_KEY, json: { workspace_id: WS, keyword_ids: [KW_PLANNED] } }));
    expect(res.status).toBe(403);
    const env = await res.json();
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("forbidden");
    expect(env.agent_guidance).toMatch(/"write" scope/);
    expect(dataWrites()).toHaveLength(0);

    const { POST: pause } = await import("@/app/api/agent/v1/workspaces/[id]/pause/route");
    const paused = await pause(request(`/workspaces/${WS}/pause`, { key: READ_KEY, method: "POST" }), params({ id: WS }));
    expect(paused.status).toBe(403);
    expect(db.tables.workspaces.find((w) => w.id === WS)!.status).toBe("on");
  });

  it("still lets a read-only key read (the GSC routes are reads)", async () => {
    const { GET } = await import("@/app/api/agent/v1/gsc/performance/route");
    const res = await GET(request(`/gsc/performance?workspace_id=${WS}`, { key: READ_KEY }));
    // Not connected is a 409 on purpose, but it got past auth: the code is not forbidden.
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_available");
  });
});

describe("POST /articles/{id}/replace", () => {
  it("previews by default and writes nothing", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/replace/route");
    const res = await POST(request(`/articles/${ART_REVIEW}/replace`, { json: { find: "acme", replace: "Zenith" } }), params({ id: ART_REVIEW }));
    expect(res.status).toBe(200);
    const env = await res.json();
    expect(env.ok).toBe(true);
    expect(env.data.preview_only).toBe(true);
    expect(env.data.written).toBe(false);
    expect(env.data.occurrences).toBe(4); // title once, body three times
    expect(env.data.hits[0].before).toContain("«Acme»");
    expect(env.agent_guidance).toMatch(/nothing changed/i);
    expect(env._human.sections[0].items.find((i: { field: string }) => i.field === "written").value_label).toMatch(/proposal only/);
    expect(dataWrites()).toHaveLength(0);
    expect(db.tables.articles.find((a) => a.id === ART_REVIEW)!.title).toBe("Acme guide");
  });

  it("writes the same change with preview_only:false and leaves status alone", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/replace/route");
    const res = await POST(
      request(`/articles/${ART_REVIEW}/replace`, { json: { find: "acme", replace: "Zenith", preview_only: false } }),
      params({ id: ART_REVIEW }),
    );
    const env = await res.json();
    expect(env.data.written).toBe(true);
    const row = db.tables.articles.find((a) => a.id === ART_REVIEW)!;
    expect(row.title).toBe("Zenith guide");
    expect(JSON.stringify(row.content)).not.toMatch(/acme/i);
    expect(row.status).toBe("review");
    const [write] = dataWrites();
    expect(write.op).toBe("update");
    expect(Object.keys(write.patch!).sort()).toEqual(["content", "title", "updated_at", "word_count"]);
    expect(write.filters.map((f) => f.col)).toEqual(["id", "workspace_id"]);
  });

  it("refuses to edit an approved article, and cannot see another account's article", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/replace/route");
    const approved = await POST(request(`/articles/${ART_APPROVED}/replace`, { json: { find: "Acme", replace: "Z", preview_only: false } }), params({ id: ART_APPROVED }));
    expect(approved.status).toBe(409);
    expect((await approved.json()).error.message).toMatch(/approved by a human/);

    const other = await POST(request(`/articles/${ART_OTHER}/replace`, { json: { find: "x", replace: "y" } }), params({ id: ART_OTHER }));
    expect(other.status).toBe(404);
    expect(dataWrites()).toHaveLength(0);
  });
});

describe("POST /articles/bulk-replace", () => {
  it("caps at 10 explicit ids", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/bulk-replace/route");
    const ids = Array.from({ length: 11 }, (_, i) => `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`);
    const res = await POST(request("/articles/bulk-replace", { json: { workspace_id: WS, find: "a", replace: "b", article_ids: ids } }));
    expect(res.status).toBe(400);
    expect((await res.json()).agent_guidance).toMatch(/max 10/);
  });

  it("previews across editable drafts and skips the approved one with a reason", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/bulk-replace/route");
    const res = await POST(request("/articles/bulk-replace", { json: { workspace_id: WS, find: "Acme", replace: "Zenith", article_ids: [ART_REVIEW, ART_APPROVED] } }));
    const env = await res.json();
    expect(env.ok).toBe(true);
    expect(env.data.preview_only).toBe(true);
    expect(env.data.results).toHaveLength(1);
    expect(env.data.skipped).toEqual([{ article_id: ART_APPROVED, title: "Approved Acme", reason: expect.stringMatching(/approved/) }]);
    expect(env.data.written).toBe(0);
    expect(dataWrites()).toHaveLength(0);
  });
});

describe("POST /articles/{id}/retry-publish", () => {
  it("refuses when the article was never published", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/retry-publish/route");
    const res = await POST(request(`/articles/${ART_APPROVED}/retry-publish`, { method: "POST" }), params({ id: ART_APPROVED }));
    expect(res.status).toBe(409);
    const env = await res.json();
    expect(env.error.message).toMatch(/never been published/);
    expect(env.agent_guidance).toMatch(/human action/);
    expect(dataWrites()).toHaveLength(0);
  });

  it("refuses when the last publish succeeded", async () => {
    db = fakeSupabase(seed({ publish_log: [{ id: "log-1", workspace_id: WS, article_id: ART_APPROVED, status: "success", error: null, destination_id: "wi-1", publish_mode: "draft", created_at: "2026-09-01T00:00:00Z" }] }));
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/retry-publish/route");
    const res = await POST(request(`/articles/${ART_APPROVED}/retry-publish`, { method: "POST" }), params({ id: ART_APPROVED }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/succeeded/);
  });

  it("refuses a failed publish whose article is back in review: a human must approve first", async () => {
    db = fakeSupabase(seed({ publish_log: [{ id: "log-1", workspace_id: WS, article_id: ART_REVIEW, status: "error", error: "500 from CMS", destination_id: "wi-1", publish_mode: "draft", created_at: "2026-09-01T00:00:00Z" }] }));
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/retry-publish/route");
    const res = await POST(request(`/articles/${ART_REVIEW}/retry-publish`, { method: "POST" }), params({ id: ART_REVIEW }));
    expect(res.status).toBe(409);
    const env = await res.json();
    expect(env.error.message).toMatch(/review, not approved/);
    expect(env.agent_guidance).toMatch(/approve the article in the dashboard/);
    expect(dataWrites()).toHaveLength(0);
  });

  it("GET /articles/{id} advertises retry_publish only for approved + failed", async () => {
    db = fakeSupabase(seed({ publish_log: [{ id: "log-1", workspace_id: WS, article_id: ART_APPROVED, status: "error", error: "boom", destination_id: "wi-1", publish_mode: "draft", created_at: "2026-09-01T00:00:00Z" }] }));
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/route");
    const env = await (await GET(request(`/articles/${ART_APPROVED}`), params({ id: ART_APPROVED }))).json();
    expect(env.data.article.allowed_mutations.retry_publish).toEqual({ allowed: true });
    expect(env.data.last_publish.status).toBe("error");
    expect(env.agent_guidance).toMatch(/retry-publish/);

    const review = await (await GET(request(`/articles/${ART_REVIEW}`), params({ id: ART_REVIEW }))).json();
    expect(review.data.article.allowed_mutations.retry_publish.allowed).toBe(false);
    expect(review.data.article.allowed_mutations.publish.allowed).toBe(false);
  });
});

describe("keyword bulk routes", () => {
  it("bulk-remove deletes the entry, stamps the keyword and deletes no keyword", async () => {
    const { POST } = await import("@/app/api/agent/v1/keywords/bulk-remove/route");
    const res = await POST(request("/keywords/bulk-remove", { json: { workspace_id: WS, keyword_ids: [KW_PLANNED] } }));
    const env = await res.json();
    expect(res.status).toBe(200);
    expect(env.data.removed).toBe(1);
    expect(env.data.keywords_deleted).toBe(0);
    expect(db.tables.calendar_entries).toHaveLength(0);
    expect(db.tables.keywords[0].plan_excluded_at).toBeTruthy();
    expect(dataWrites().map((w) => `${w.op}:${w.table}`)).toEqual(["delete:calendar_entries", "update:keywords"]);
  });

  it("bulk-reschedule shifts and reports planned_for on the next list", async () => {
    const { POST } = await import("@/app/api/agent/v1/keywords/bulk-reschedule/route");
    const res = await POST(request("/keywords/bulk-reschedule", { json: { workspace_id: WS, keyword_ids: [KW_PLANNED], shift_days: 7 } }));
    const env = await res.json();
    expect(env.data.moved).toBe(1);
    expect(env.data.outcomes[0]).toMatchObject({ from: "2026-10-01", to: "2026-10-08" });

    const { GET } = await import("@/app/api/agent/v1/keywords/route");
    const list = await (await GET(request(`/keywords?workspace_id=${WS}`))).json();
    expect(list.data.keywords[0].planned_for).toBe("2026-10-08");
    expect(list.data.keywords[0].allowed_mutations.reschedule).toEqual({ allowed: true });
  });

  it("bulk-reschedule rejects a body that says both items and keyword_ids", async () => {
    const { POST } = await import("@/app/api/agent/v1/keywords/bulk-reschedule/route");
    const res = await POST(request("/keywords/bulk-reschedule", { json: { workspace_id: WS, keyword_ids: [KW_PLANNED], shift_days: 1, items: [{ keyword_id: KW_PLANNED, date: "2026-10-02" }] } }));
    expect(res.status).toBe(400);
  });

  it("refuses another account's workspace", async () => {
    const { POST } = await import("@/app/api/agent/v1/keywords/bulk-remove/route");
    const res = await POST(request("/keywords/bulk-remove", { json: { workspace_id: OTHER_WS, keyword_ids: [KW_PLANNED] } }));
    expect(res.status).toBe(404);
  });

  it("export serves CSV as a file and JSON as an envelope, with blanks for unmeasured", async () => {
    const { GET } = await import("@/app/api/agent/v1/keywords/export/route");
    const csv = await GET(request(`/keywords/export?workspace_id=${WS}&format=csv`));
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/keywords-acme.com.csv/);
    expect(csv.headers.get("x-ratelimit-limit")).toBe("120");
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("id,term,volume,difficulty,cpc,intent,status,planned_for,created_at");
    expect(text).toMatch(/acme widgets,,,,,planned,2026-10-01/);

    const json = await (await GET(request(`/keywords/export?workspace_id=${WS}`))).json();
    expect(json.ok).toBe(true);
    expect(json.data.rows[0]).toMatchObject({ term: "acme widgets", volume: null, planned_for: "2026-10-01" });
  });
});

describe("workspace pause / resume", () => {
  it("pauses with paused_meta and is idempotent", async () => {
    const { POST } = await import("@/app/api/agent/v1/workspaces/[id]/pause/route");
    const first = await (await POST(request(`/workspaces/${WS}/pause`, { method: "POST" }), params({ id: WS }))).json();
    expect(first.data.changed).toBe(true);
    expect(first.data.paused_meta).toMatchObject({ previous_status: "on", by: null });
    expect(first.data.paused_by_key).toBe("writer");
    const row = db.tables.workspaces.find((w) => w.id === WS)!;
    expect(row.status).toBe("paused");

    const again = await (await POST(request(`/workspaces/${WS}/pause`, { method: "POST" }), params({ id: WS }))).json();
    expect(again.data.changed).toBe(false);
    expect(again.agent_guidance).toMatch(/already paused/);
  });

  it("resumes to the previous status; refuses to lift a billing pause", async () => {
    db = fakeSupabase(seed());
    db.tables.workspaces.find((w) => w.id === WS)!.status = "paused";
    db.tables.workspaces.find((w) => w.id === WS)!.paused_meta = { since: "2026-09-01T00:00:00Z", previous_status: "review", by: null };
    const { POST } = await import("@/app/api/agent/v1/workspaces/[id]/resume/route");
    const env = await (await POST(request(`/workspaces/${WS}/resume`, { method: "POST" }), params({ id: WS }))).json();
    expect(env.ok).toBe(true);
    expect(env.data.status).toBe("review");
    expect(db.tables.workspaces.find((w) => w.id === WS)!.paused_meta).toBeNull();

    db = fakeSupabase(seed());
    Object.assign(db.tables.workspaces.find((w) => w.id === WS)!, { status: "paused", paused_until: "2026-12-01T00:00:00Z" });
    const billing = await POST(request(`/workspaces/${WS}/resume`, { method: "POST" }), params({ id: WS }));
    expect(billing.status).toBe(409);
    expect((await billing.json()).error.message).toMatch(/Billing/);
  });
});

describe("GSC reads", () => {
  it("says not connected as ok:false, never as an empty result", async () => {
    const routes = [
      import("@/app/api/agent/v1/gsc/performance/route"),
      import("@/app/api/agent/v1/gsc/cannibalization/route"),
      import("@/app/api/agent/v1/gsc/coverage/route"),
    ];
    for (const { GET } of await Promise.all(routes)) {
      const res = await GET(request(`/gsc/x?workspace_id=${WS}`));
      expect(res.status).toBe(409);
      const env = await res.json();
      expect(env.ok).toBe(false);
      expect(env.agent_guidance).toMatch(/not connected/i);
      expect(env.agent_guidance).toMatch(/not zero traffic/i);
    }
    const { GET: inspect } = await import("@/app/api/agent/v1/gsc/url-inspection/route");
    expect((await inspect(request(`/gsc/url-inspection?workspace_id=${WS}&url=https://acme.com/x`))).status).toBe(409);
    expect((await inspect(request(`/gsc/url-inspection?workspace_id=${WS}`))).status).toBe(400);
  });

  it("connected but unsynced is ok:true with has_data false and its own sentence", async () => {
    db = fakeSupabase(seed({ workspace_integrations: [{ id: "wi-gsc", workspace_id: WS, integration_id: "gsc", connected_at: "2026-09-01T00:00:00Z", config: { gscSiteUrl: "sc-domain:acme.com" } }] }));
    const { GET } = await import("@/app/api/agent/v1/gsc/performance/route");
    const env = await (await GET(request(`/gsc/performance?workspace_id=${WS}`))).json();
    expect(env.ok).toBe(true);
    expect(env.data.has_data).toBe(false);
    expect(env.data.sync.site_url).toBe("sc-domain:acme.com");
    expect(env.agent_guidance).toMatch(/no data has been synced yet/);
  });

  it("serves stored rows with the dashboard's arithmetic", async () => {
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    db = fakeSupabase(
      seed({
        workspace_integrations: [{ id: "wi-gsc", workspace_id: WS, integration_id: "gsc", connected_at: "2026-09-01T00:00:00Z", config: {} }],
        analytics_metrics: [
          { id: "m1", workspace_id: WS, source: "gsc", metric_date: day, clicks: 10, impressions: 100, avg_position: 5, page_url: null, query: null, article_id: null, created_at: "2026-09-04T04:00:00Z" },
          { id: "m2", workspace_id: WS, source: "gsc", metric_date: day, clicks: 6, impressions: 50, avg_position: 4, page_url: "https://acme.com/a", query: "acme", article_id: null, created_at: "2026-09-04T04:00:00Z" },
          { id: "m3", workspace_id: WS, source: "gsc", metric_date: day, clicks: 4, impressions: 50, avg_position: 8, page_url: "https://acme.com/b", query: "acme", article_id: null, created_at: "2026-09-04T04:00:00Z" },
          { id: "m4", workspace_id: OTHER_WS, source: "gsc", metric_date: day, clicks: 999, impressions: 9999, avg_position: 1, page_url: null, query: null, article_id: null, created_at: "2026-09-04T04:00:00Z" },
        ],
      }),
    );
    const { GET: perf } = await import("@/app/api/agent/v1/gsc/performance/route");
    const p = await (await perf(request(`/gsc/performance?workspace_id=${WS}`))).json();
    expect(p.data.clicks.current).toBe(10); // totals row only; never the other workspace's 999
    expect(p.data.clicks.changePct).toBeNull();
    expect(p.agent_guidance).toMatch(/no previous window/);

    const { GET: cann } = await import("@/app/api/agent/v1/gsc/cannibalization/route");
    const c = await (await cann(request(`/gsc/cannibalization?workspace_id=${WS}`))).json();
    expect(c.data.count).toBe(1);
    expect(c.data.issues[0].query).toBe("acme");
    expect(c.data.issues[0].winner.url).toBe("https://acme.com/a");
    expect(c.data.issues[0].suggestions[0].action).toBe("differentiate");
  });
});
