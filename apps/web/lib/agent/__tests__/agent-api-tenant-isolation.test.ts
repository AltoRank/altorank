// ---------------------------------------------------------------------------
// The agent API, called with one account's key against another's resources
// ---------------------------------------------------------------------------
//
// /api/agent/v1 authenticates a bearer key and then runs every query on the
// SERVICE ROLE, because a key is not a Supabase session and there is no RLS to
// resolve. That moves the whole tenancy boundary into lib/agent/data.ts and
// the route handlers: if one of them names a row by id and forgets the account,
// the database will happily hand over another customer's article.
//
// So these tests import the real route handlers - the exported GET and POST -
// and call them with account A's key and account B's ids. They also pin the
// credential rules the same module owns: a revoked key stops working on the
// next request, an expired key never worked, and a key without the `write`
// scope cannot mutate.
//
// Needs the local Supabase stack; skips itself when it is not answering.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "../api-keys";

function loadEnv(): { url: string; anon: string; service: string } | null {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const file of [".env.development.local", ".env.local"]) {
    try {
      const text = readFileSync(path.resolve(__dirname, "../../..", file), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // Absent is fine.
    }
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return null;
  // The route handlers build their own service client from the environment.
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
  process.env.SUPABASE_SERVICE_ROLE_KEY = service;
  return { url, anon, service };
}

const ENV = loadEnv();
const LIVE = ENV
  ? await fetch(`${ENV.url}/auth/v1/health`, {
      headers: { apikey: ENV.anon },
      signal: AbortSignal.timeout(2_000),
    })
      .then((r) => r.ok)
      .catch(() => false)
  : false;

const SLUGS = ["agent-iso-a", "agent-iso-b"];

type Fixture = {
  admin: SupabaseClient;
  keyA: string;
  keyAReadOnly: string;
  keyARevoked: string;
  keyAExpired: string;
  wsA: string;
  wsB: string;
  articleB: string;
  revokedKeyId: string;
};

let fx: Fixture;

/** A request the route handlers accept, carrying a bearer key. */
function req(
  url: string,
  key: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`https://app.altorank.co${url}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function body(res: Response) {
  return (await res.json()) as { ok: boolean; error?: { code: string; message: string } };
}

async function seed(): Promise<Fixture> {
  const admin = createClient(ENV!.url, ENV!.service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await admin.from("accounts").delete().in("slug", SLUGS);

  const { data: accounts, error } = await admin
    .from("accounts")
    .insert([
      { name: "Agent Iso A", slug: SLUGS[0] },
      { name: "Agent Iso B", slug: SLUGS[1] },
    ])
    .select("id, slug");
  if (error || !accounts) throw new Error(`accounts: ${error?.message}`);
  const accountA = accounts.find((a) => a.slug === SLUGS[0])!.id as string;
  const accountB = accounts.find((a) => a.slug === SLUGS[1])!.id as string;

  const { data: workspaces, error: wsErr } = await admin
    .from("workspaces")
    .insert([
      { account_id: accountA, name: "Agent A", domain: "agent-iso-a.test", initials: "AA", color: "av-c1" },
      { account_id: accountB, name: "Agent B", domain: "agent-iso-b.test", initials: "AB", color: "av-c1" },
    ])
    .select("id, domain");
  if (wsErr || !workspaces) throw new Error(`workspaces: ${wsErr?.message}`);
  const wsA = workspaces.find((w) => w.domain === "agent-iso-a.test")!.id as string;
  const wsB = workspaces.find((w) => w.domain === "agent-iso-b.test")!.id as string;

  const { data: articles, error: artErr } = await admin
    .from("articles")
    .insert([
      { workspace_id: wsA, title: "A draft", slug: "agent-iso-a", status: "draft", content: { type: "doc", content: [] } },
      { workspace_id: wsB, title: "B draft", slug: "agent-iso-b", status: "draft", content: { type: "doc", content: [] } },
    ])
    .select("id, slug");
  if (artErr || !articles) throw new Error(`articles: ${artErr?.message}`);

  const full = generateApiKey();
  const readOnly = generateApiKey();
  const revoked = generateApiKey();
  const expired = generateApiKey();
  const { data: keys, error: keyErr } = await admin
    .from("api_keys")
    .insert([
      { account_id: accountA, name: "full", key_hash: full.hash, prefix: full.prefix, scopes: ["read", "generate", "write"] },
      { account_id: accountA, name: "read only", key_hash: readOnly.hash, prefix: readOnly.prefix, scopes: ["read"] },
      {
        account_id: accountA,
        name: "revoked",
        key_hash: revoked.hash,
        prefix: revoked.prefix,
        scopes: ["read"],
        revoked_at: new Date().toISOString(),
      },
      {
        account_id: accountA,
        name: "expired",
        key_hash: expired.hash,
        prefix: expired.prefix,
        scopes: ["read"],
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ])
    .select("id, name");
  if (keyErr || !keys) throw new Error(`api_keys: ${keyErr?.message}`);

  return {
    admin,
    keyA: full.key,
    keyAReadOnly: readOnly.key,
    keyARevoked: revoked.key,
    keyAExpired: expired.key,
    wsA,
    wsB,
    articleB: articles.find((a) => a.slug === "agent-iso-b")!.id as string,
    revokedKeyId: keys.find((k) => k.name === "revoked")!.id as string,
  };
}

describe.skipIf(!LIVE)("agent API: account A's key against account B", () => {
  beforeAll(async () => {
    fx = await seed();
  }, 60_000);

  afterAll(async () => {
    if (fx?.admin) await fx.admin.from("accounts").delete().in("slug", SLUGS);
  }, 30_000);

  it("GET /workspaces lists only its own account", async () => {
    const { GET } = await import("@/app/api/agent/v1/workspaces/route");
    const res = await GET(req("/api/agent/v1/workspaces", fx.keyA));
    const json = (await res.json()) as { ok: boolean; data: { workspaces: { id: string }[] } };
    expect(json.ok).toBe(true);
    expect(json.data.workspaces.map((w) => w.id)).toEqual([fx.wsA]);
  });

  it("GET /workspaces/{id} refuses B's site", async () => {
    const { GET } = await import("@/app/api/agent/v1/workspaces/[id]/route");
    const res = await GET(req(`/api/agent/v1/workspaces/${fx.wsB}`, fx.keyA), {
      params: Promise.resolve({ id: fx.wsB }),
    });
    expect(res.status).toBe(404);
    expect((await body(res)).error?.code).toBe("not_found");
  });

  it("GET /articles?workspace_id= refuses B's site", async () => {
    const { GET } = await import("@/app/api/agent/v1/articles/route");
    const res = await GET(req(`/api/agent/v1/articles?workspace_id=${fx.wsB}`, fx.keyA));
    expect((await body(res)).error?.code).toBe("not_found");
  });

  it("GET /articles/{id} refuses B's draft", async () => {
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/route");
    const res = await GET(req(`/api/agent/v1/articles/${fx.articleB}`, fx.keyA), {
      params: Promise.resolve({ id: fx.articleB }),
    });
    expect((await body(res)).error?.code).toBe("not_found");
  });

  it("GET /articles/{id}/content refuses B's draft", async () => {
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    const res = await GET(req(`/api/agent/v1/articles/${fx.articleB}/content`, fx.keyA), {
      params: Promise.resolve({ id: fx.articleB }),
    });
    expect((await body(res)).error?.code).toBe("not_found");
  });

  it("GET /keywords refuses B's site", async () => {
    const { GET } = await import("@/app/api/agent/v1/keywords/route");
    const res = await GET(req(`/api/agent/v1/keywords?workspace_id=${fx.wsB}`, fx.keyA));
    expect((await body(res)).error?.code).toBe("not_found");
  });

  it("POST /articles/{id}/replace leaves B's draft untouched", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/replace/route");
    const res = await POST(
      req(`/api/agent/v1/articles/${fx.articleB}/replace`, fx.keyA, {
        method: "POST",
        body: JSON.stringify({ find: "B", replace: "taken over", preview_only: false }),
      }),
      { params: Promise.resolve({ id: fx.articleB }) },
    );
    expect((await body(res)).error?.code).toBe("not_found");
    const { data } = await fx.admin.from("articles").select("title").eq("id", fx.articleB).single();
    expect(data?.title).toBe("B draft");
  });

  it("POST /workspaces/{id}/pause leaves B's site running", async () => {
    const { POST } = await import("@/app/api/agent/v1/workspaces/[id]/pause/route");
    const res = await POST(req(`/api/agent/v1/workspaces/${fx.wsB}/pause`, fx.keyA, { method: "POST" }), {
      params: Promise.resolve({ id: fx.wsB }),
    });
    expect((await body(res)).error?.code).toBe("not_found");
    const { data } = await fx.admin.from("workspaces").select("status").eq("id", fx.wsB).single();
    expect(data?.status).not.toBe("paused");
  });

  it("POST /keywords/bulk-remove refuses B's site", async () => {
    const { POST } = await import("@/app/api/agent/v1/keywords/bulk-remove/route");
    const res = await POST(
      req("/api/agent/v1/keywords/bulk-remove", fx.keyA, {
        method: "POST",
        body: JSON.stringify({ workspace_id: fx.wsB, keyword_ids: [crypto.randomUUID()] }),
      }),
    );
    expect((await body(res)).error?.code).toBe("not_found");
  });

  it("POST /articles/bulk-replace refuses B's site", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/bulk-replace/route");
    const res = await POST(
      req("/api/agent/v1/articles/bulk-replace", fx.keyA, {
        method: "POST",
        body: JSON.stringify({ workspace_id: fx.wsB, find: "B", replace: "x" }),
      }),
    );
    expect((await body(res)).error?.code).toBe("not_found");
  });
});

describe.skipIf(!LIVE)("agent API: the key itself", () => {
  beforeAll(async () => {
    fx = await seed();
  }, 60_000);

  afterAll(async () => {
    if (fx?.admin) await fx.admin.from("accounts").delete().in("slug", SLUGS);
  }, 30_000);

  it("refuses a revoked key", async () => {
    const { GET } = await import("@/app/api/agent/v1/auth/whoami/route");
    const res = await GET(req("/api/agent/v1/auth/whoami", fx.keyARevoked));
    expect(res.status).toBe(401);
    const json = await body(res);
    expect(json.error?.code).toBe("unauthorized");
    expect(json.error?.message).toMatch(/revoked/i);
  });

  it("refuses an expired key", async () => {
    const { GET } = await import("@/app/api/agent/v1/auth/whoami/route");
    const res = await GET(req("/api/agent/v1/auth/whoami", fx.keyAExpired));
    expect(res.status).toBe(401);
    expect((await body(res)).error?.message).toMatch(/expired/i);
  });

  it("a revoked key cannot read anything, not just whoami", async () => {
    const { GET } = await import("@/app/api/agent/v1/workspaces/route");
    for (const key of [fx.keyARevoked, fx.keyAExpired]) {
      const res = await GET(req("/api/agent/v1/workspaces", key));
      expect(res.status).toBe(401);
    }
  });

  it("a key without the write scope cannot mutate, and the site keeps running", async () => {
    const { POST } = await import("@/app/api/agent/v1/workspaces/[id]/pause/route");
    const res = await POST(req(`/api/agent/v1/workspaces/${fx.wsA}/pause`, fx.keyAReadOnly, { method: "POST" }), {
      params: Promise.resolve({ id: fx.wsA }),
    });
    expect(res.status).toBe(403);
    const json = await body(res);
    expect(json.error?.code).toBe("forbidden");
    expect(json.error?.message).toMatch(/write/i);
    const { data } = await fx.admin.from("workspaces").select("status").eq("id", fx.wsA).single();
    expect(data?.status).not.toBe("paused");
  });

  it("refuses an unknown key, a malformed one, and no key at all", async () => {
    const { GET } = await import("@/app/api/agent/v1/workspaces/route");
    const unknown = await GET(req("/api/agent/v1/workspaces", generateApiKey().key));
    expect(unknown.status).toBe(401);
    const malformed = await GET(req("/api/agent/v1/workspaces", "not-a-key"));
    expect(malformed.status).toBe(401);
    const missing = await GET(new NextRequest("https://app.altorank.co/api/agent/v1/workspaces"));
    expect(missing.status).toBe(401);
  });

  // Last in the file on purpose: it revokes the read-only key.
  it("revocation takes effect on the very next request", async () => {
    const { hashApiKey } = await import("../api-keys");
    const { GET } = await import("@/app/api/agent/v1/workspaces/route");
    const before = await GET(req("/api/agent/v1/workspaces", fx.keyAReadOnly));
    expect(before.status).toBe(200);

    await fx.admin
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("key_hash", hashApiKey(fx.keyAReadOnly));

    const after = await GET(req("/api/agent/v1/workspaces", fx.keyAReadOnly));
    expect(after.status).toBe(401);
    expect((await body(after)).error?.message).toMatch(/revoked/i);
  });

  it("sends the rate-limit headers on every answer", async () => {
    const { GET } = await import("@/app/api/agent/v1/workspaces/route");
    const res = await GET(req("/api/agent/v1/workspaces", fx.keyA));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(Number(res.headers.get("X-RateLimit-Remaining"))).toBeLessThan(120);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
