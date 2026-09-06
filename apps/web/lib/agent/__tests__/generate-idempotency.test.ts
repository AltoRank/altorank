/**
 * POST /articles/generate with an Idempotency-Key: the retry after a timeout
 * must come back with the draft the first call started, and nothing else
 * may have been written or billed. Real auth, real handler, fake database;
 * the quota read and the model call are stubbed, `after()` is captured.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/agent/api-keys";
import { IDEMPOTENCY_TTL_MS } from "@/lib/agent/idempotency";
import { fakeSupabase, type FakeSupabase, type Seed } from "./fake-supabase";

let db: FakeSupabase;
const afterCalls: Array<() => Promise<void>> = [];
const quota = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => db,
  createClient: async () => db,
}));
vi.mock("@/lib/billing/quota", () => ({
  getQuota: (...args: unknown[]) => quota(...args),
  freeAllowanceUsedMessage: () => "Free drafts used.",
  quotaExceededMessage: () => "Quota exceeded.",
}));
vi.mock("@/lib/content/generate", () => ({
  generateArticle: vi.fn(async () => ({})),
  slugFor: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => {
    afterCalls.push(fn);
  },
}));

const AGENCY = "agency-1";
const WS = "11111111-1111-4111-8111-111111111111";
const KEY = "altorank_live_" + "G".repeat(40);

function seed(): Seed {
  const now = new Date().toISOString();
  return {
    api_keys: [{ id: "key-gen", agency_id: AGENCY, name: "gen", scopes: ["read", "generate"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(KEY) }],
    workspaces: [{ id: WS, agency_id: AGENCY, name: "Acme", domain: "acme.com", status: "on", ai_provider: "claude", created_at: now }],
    articles: [],
    agent_idempotency_keys: [],
  };
}

function generate(json: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3132/api/agent/v1/articles/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ workspace_id: WS, keyword: "acme widgets", ...json }),
  });
}

const drafts = () => db.tables.articles.filter((a) => a.workspace_id === WS);
const unmetered = { limit: null, used: 0, remaining: null, reason: "self-host", plan: null };

beforeEach(() => {
  db = fakeSupabase(seed());
  afterCalls.length = 0;
  quota.mockReset();
  quota.mockResolvedValue(unmetered);
});

describe("POST /articles/generate idempotency", () => {
  it("answers a repeated key with the same draft: one row, one run, nothing new billed", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const first = await POST(generate({ idempotency_key: "draft-1" }));
    expect(first.status).toBe(202);
    const a = await first.json();
    expect(a.data.replayed).toBe(false);
    expect(drafts()).toHaveLength(1);
    expect(afterCalls).toHaveLength(1);

    const second = await POST(generate({ idempotency_key: "draft-1" }));
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.ok).toBe(true);
    expect(b.data.article_id).toBe(a.data.article_id);
    expect(b.data.replayed).toBe(true);
    expect(b.data.poll_url).toBe(a.data.poll_url);
    expect(b.agent_guidance).toMatch(/already used/);
    expect(b.agent_guidance).toMatch(/nothing more was billed/);
    // No second row, no second generation, no second trip through the spend gate.
    expect(drafts()).toHaveLength(1);
    expect(afterCalls).toHaveLength(1);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(db.tables.agent_idempotency_keys).toEqual([
      expect.objectContaining({ agency_id: AGENCY, key: "draft-1", article_id: a.data.article_id }),
    ]);
  });

  it("treats the header and the body field as the same key", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const a = await (await POST(generate({}, { "Idempotency-Key": "  hdr-1  " }))).json();
    const b = await (await POST(generate({ idempotency_key: "hdr-1" }))).json();
    expect(b.data.replayed).toBe(true);
    expect(b.data.article_id).toBe(a.data.article_id);
    expect(drafts()).toHaveLength(1);
  });

  it("starts a new draft for a different key, and for no key at all", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    await POST(generate({ idempotency_key: "k1" }));
    await POST(generate({ idempotency_key: "k2" }));
    await POST(generate({}));
    await POST(generate({}));
    expect(drafts()).toHaveLength(4);
    expect(afterCalls).toHaveLength(4);
    // A call without a key is told what it gave up.
    const bare = await (await POST(generate({}))).json();
    expect(bare.agent_guidance).toMatch(/Idempotency-Key/);
  });

  it("reclaims a key older than 24 hours instead of replaying a stale draft", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const a = await (await POST(generate({ idempotency_key: "old" }))).json();
    db.tables.agent_idempotency_keys[0].created_at = new Date(Date.now() - IDEMPOTENCY_TTL_MS - 60_000).toISOString();
    const b = await (await POST(generate({ idempotency_key: "old" }))).json();
    expect(b.data.replayed).toBe(false);
    expect(b.data.article_id).not.toBe(a.data.article_id);
    expect(drafts()).toHaveLength(2);
    expect(db.tables.agent_idempotency_keys).toHaveLength(1);
    expect(db.tables.agent_idempotency_keys[0].article_id).toBe(b.data.article_id);
  });

  it("releases the key when the spend gate refuses, so the same key works once the human says yes", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    quota.mockResolvedValue({ limit: 5, used: 5, remaining: 0, reason: "plan", plan: "starter" });
    const refused = await POST(generate({ idempotency_key: "over" }));
    expect(refused.status).toBe(402);
    expect(drafts()).toHaveLength(0);
    expect(db.tables.agent_idempotency_keys).toHaveLength(0);

    const allowed = await POST(generate({ idempotency_key: "over", allow_overage: true }));
    expect(allowed.status).toBe(202);
    const env = await allowed.json();
    expect(env.data.replayed).toBe(false);
    expect(env.data.overage).toBe(true);
    expect(drafts()).toHaveLength(1);
  });

  it("refuses a key it could not store rather than silently running without one", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const long = await POST(generate({ idempotency_key: "x".repeat(201) }));
    expect(long.status).toBe(400);
    expect((await long.json()).error.message).toMatch(/longer than 200/);
    const control = await POST(generate({ idempotency_key: `a${String.fromCharCode(1)}b` }));
    expect(control.status).toBe(400);
    expect(drafts()).toHaveLength(0);
  });

  it("starts over when the key's draft was deleted, instead of replaying a row that is gone", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const a = await (await POST(generate({ idempotency_key: "gone" }))).json();
    db.tables.articles = db.tables.articles.filter((r) => r.id !== a.data.article_id);
    const b = await (await POST(generate({ idempotency_key: "gone" }))).json();
    expect(b.ok).toBe(true);
    expect(b.data.replayed).toBe(false);
    expect(b.data.article_id).not.toBe(a.data.article_id);
    expect(db.tables.agent_idempotency_keys.map((k) => k.article_id)).toEqual([b.data.article_id]);
  });
});
