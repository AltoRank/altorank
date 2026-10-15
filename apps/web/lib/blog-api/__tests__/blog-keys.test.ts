import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { generateApiKey } from "@/lib/agent/api-keys";

// ---------------------------------------------------------------------------
// Which keys the blog API takes, and for which site
// ---------------------------------------------------------------------------
//
// A blog key (scopes {blog}, migration 118) reads the one site it names. The
// agent keys and the legacy account key that sites were set up with before
// keep working. A workspace the key cannot read is a 403, never a 404 the
// client would take for "no articles".

vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: async () => "open" }));

const blogKey = generateApiKey();
const agentKey = generateApiKey();
const writeOnlyKey = generateApiKey();
const revokedBlogKey = generateApiKey();
const expiredBlogKey = generateApiKey();
const siteLessBlogKey = generateApiKey();
const movedSiteBlogKey = generateApiKey();

const SITE_A = "aaaaaaaa-1111-4111-8111-11111111111b";
const SITE_B = "22222222-2222-4222-8222-222222222222";
const OTHER_ACCOUNT_SITE = "33333333-3333-4333-8333-333333333333";

function seed() {
  return fakeSupabase({
    api_keys: [
      { id: "k-blog", account_id: "acc-1", key_hash: blogKey.hash, scopes: ["blog"], workspace_id: SITE_A, revoked_at: null, expires_at: null, last_used_at: null },
      { id: "k-agent", account_id: "acc-1", key_hash: agentKey.hash, scopes: ["read", "generate"], workspace_id: null, revoked_at: null, expires_at: null, last_used_at: new Date().toISOString() },
      { id: "k-write", account_id: "acc-1", key_hash: writeOnlyKey.hash, scopes: ["write"], workspace_id: null, revoked_at: null, expires_at: null, last_used_at: null },
      { id: "k-revoked", account_id: "acc-1", key_hash: revokedBlogKey.hash, scopes: ["blog"], workspace_id: SITE_A, revoked_at: "2026-10-01T00:00:00Z", expires_at: null, last_used_at: null },
      { id: "k-expired", account_id: "acc-1", key_hash: expiredBlogKey.hash, scopes: ["blog"], workspace_id: SITE_A, revoked_at: null, expires_at: "2026-01-01T00:00:00Z", last_used_at: null },
      // Shapes migration 118's check refuses, in case a row predates it.
      { id: "k-siteless", account_id: "acc-1", key_hash: siteLessBlogKey.hash, scopes: ["blog", "read"], workspace_id: null, revoked_at: null, expires_at: null, last_used_at: null },
      // Bound to a site that is no longer on the key's account.
      { id: "k-moved", account_id: "acc-1", key_hash: movedSiteBlogKey.hash, scopes: ["blog"], workspace_id: OTHER_ACCOUNT_SITE, revoked_at: null, expires_at: null, last_used_at: null },
    ],
    accounts: [{ id: "acc-1", api_key: "legacy-plaintext-key" }, { id: "acc-2", api_key: null }],
    workspaces: [
      { id: SITE_A, account_id: "acc-1", domain: "client-a.example" },
      { id: SITE_B, account_id: "acc-1", domain: "client-b.example" },
      { id: OTHER_ACCOUNT_SITE, account_id: "acc-2", domain: "someone-else.example" },
    ],
  });
}

let db: FakeSupabase | { from: (t: string) => unknown } = seed();
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));

const { authenticateBlogRequest, blogRateLimiter, BLOG_RATE_LIMIT } = await import("../auth");

function req(key: string, workspaceId?: string) {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  return new Request(`https://app.example/api/blog/v1/articles${qs}`, { headers: { authorization: `Bearer ${key}` } });
}

async function denial(auth: Awaited<ReturnType<typeof authenticateBlogRequest>>) {
  if (auth.ok) throw new Error("expected a refusal");
  return { status: auth.response.status, body: (await auth.response.json()) as { error: string } };
}

beforeEach(() => {
  db = seed();
  // A fresh limiter window per test: the module's buckets outlive a test.
  (blogRateLimiter as unknown as { buckets: Map<string, unknown> }).buckets.clear();
});

describe("blog keys", () => {
  it("read the site they are bound to", async () => {
    const auth = await authenticateBlogRequest(req(blogKey.key, SITE_A));
    expect(auth).toMatchObject({ ok: true, workspaceId: SITE_A, keyKind: "blog" });
  });

  it("may leave workspace_id out, since the key names its site", async () => {
    const auth = await authenticateBlogRequest(req(blogKey.key));
    expect(auth).toMatchObject({ ok: true, workspaceId: SITE_A });
  });

  it("are refused for another site on the same account, with a 403", async () => {
    const { status, body } = await denial(await authenticateBlogRequest(req(blogKey.key, SITE_B)));
    expect(status).toBe(403);
    expect(body.error).toMatch(/different site/);
  });

  it("stop working once revoked", async () => {
    expect((await denial(await authenticateBlogRequest(req(revokedBlogKey.key, SITE_A)))).status).toBe(401);
  });

  it("match their site whatever the case of workspace_id", async () => {
    const auth = await authenticateBlogRequest(req(blogKey.key, SITE_A.toUpperCase()));
    expect(auth).toMatchObject({ ok: true, workspaceId: SITE_A });
  });

  it("stop working once expired", async () => {
    expect((await denial(await authenticateBlogRequest(req(expiredBlogKey.key, SITE_A)))).status).toBe(401);
  });

  it("without a site are refused, even with read alongside, rather than read the account", async () => {
    expect((await denial(await authenticateBlogRequest(req(siteLessBlogKey.key, SITE_A)))).status).toBe(401);
    expect((await denial(await authenticateBlogRequest(req(siteLessBlogKey.key, SITE_B)))).status).toBe(401);
  });

  it("cannot read their site once it belongs to another account", async () => {
    expect((await denial(await authenticateBlogRequest(req(movedSiteBlogKey.key)))).status).toBe(403);
    expect((await denial(await authenticateBlogRequest(req(movedSiteBlogKey.key, SITE_A)))).status).toBe(403);
  });

  it("record that they were used, so Settings does not show them as unused", async () => {
    await authenticateBlogRequest(req(blogKey.key, SITE_A));
    await new Promise((r) => setTimeout(r, 0));
    const write = (db as FakeSupabase).writes.find((w) => w.table === "api_keys" && w.op === "update");
    expect(write?.patch).toHaveProperty("last_used_at");
    expect(write?.filters).toContainEqual({ kind: "eq", col: "id", value: "k-blog" });
  });
});

describe("keys from before blog keys", () => {
  it("an agent key with read still reads any site on its account", async () => {
    expect(await authenticateBlogRequest(req(agentKey.key, SITE_B))).toMatchObject({ ok: true, keyKind: "agent", workspaceId: SITE_B });
  });

  it("does not rewrite last_used_at more than once a minute", async () => {
    await authenticateBlogRequest(req(agentKey.key, SITE_B));
    await new Promise((r) => setTimeout(r, 0));
    expect((db as FakeSupabase).writes.filter((w) => w.table === "api_keys")).toHaveLength(0);
  });

  it("the legacy account key still reads its account's sites", async () => {
    expect(await authenticateBlogRequest(req("legacy-plaintext-key", SITE_A))).toMatchObject({ ok: true, keyKind: "legacy" });
  });

  it("an agent key without read is refused", async () => {
    expect((await denial(await authenticateBlogRequest(req(writeOnlyKey.key, SITE_A)))).status).toBe(403);
  });

  it("still need workspace_id", async () => {
    expect((await denial(await authenticateBlogRequest(req(agentKey.key)))).status).toBe(400);
  });
});

describe("a workspace the key cannot read", () => {
  it("is a 403, so the client fails the build instead of serving an empty blog", async () => {
    const { status, body } = await denial(await authenticateBlogRequest(req(agentKey.key, OTHER_ACCOUNT_SITE)));
    expect(status).toBe(403);
    expect(body.error).toMatch(/workspace/);
  });

  it("is a 403 for a site that does not exist any more", async () => {
    expect((await denial(await authenticateBlogRequest(req(agentKey.key, "44444444-4444-4444-8444-444444444444")))).status).toBe(403);
  });
});

describe("rate limit", () => {
  it("answers 429 with Retry-After once a key passes the limit", async () => {
    for (let i = 0; i < BLOG_RATE_LIMIT; i++) blogRateLimiter.check("k-blog");
    const auth = await authenticateBlogRequest(req(blogKey.key, SITE_A));
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.response.status).toBe(429);
    expect(Number(auth.response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts the legacy key per account", async () => {
    for (let i = 0; i < BLOG_RATE_LIMIT; i++) blogRateLimiter.check("legacy:acc-1");
    expect((await denial(await authenticateBlogRequest(req("legacy-plaintext-key", SITE_A)))).status).toBe(429);
  });
});

describe("before migration 118", () => {
  it("reads the key without workspace_id and serves agent keys as before", async () => {
    const real = seed();
    db = {
      from(table: string) {
        const q = real.from(table) as Record<string, (...a: unknown[]) => unknown>;
        if (table !== "api_keys") return q;
        const select = q.select;
        q.select = (cols: unknown, ...rest: unknown[]) => {
          if (typeof cols === "string" && cols.includes("workspace_id")) {
            const failing: Record<string, unknown> = {};
            failing.eq = () => failing;
            failing.maybeSingle = () => Promise.resolve({ data: null, error: { code: "42703", message: "column api_keys.workspace_id does not exist" } });
            return failing;
          }
          return select(cols, ...rest);
        };
        return q;
      },
    };
    expect(await authenticateBlogRequest(req(agentKey.key, SITE_B))).toMatchObject({ ok: true, keyKind: "agent" });
  });
});
