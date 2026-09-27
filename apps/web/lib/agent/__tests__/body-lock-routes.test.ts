/**
 * The agent API's article-text routes, before and after the trial.
 *
 * The CLI, the stdio MCP server and the hosted /api/mcp all read an article's
 * text through GET /articles/{id}/content, and a find-and-replace preview
 * quotes every hit with its sentence - a search for "the" returns the whole
 * article. An account that has not started its trial gets neither
 * (lib/billing/trial.ts, draftBodyLocked); a paying one gets both, unchanged.
 *
 * Real auth, real handlers, the in-memory database. Only the quota is
 * stubbed, because it is the input the gate decides on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/agent/api-keys";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import type { Quota } from "@/lib/billing/quota";
import { fakeSupabase, type FakeSupabase } from "./fake-supabase";

let db: FakeSupabase & { auth: Record<string, unknown> };
let quota: Quota;

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => db,
  createClient: async () => db,
}));

vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: vi.fn(async () => quota),
}));

const ACCOUNT = "account-1";
const WS = "11111111-1111-4111-8111-111111111111";
const ART = "33333333-3333-4333-8333-333333333333";
const KEY = "altorank_live_" + "K".repeat(40);
const CREATOR = "user-1";

/** The one sentence that must never leave before the trial. Invented. */
const SECRET = "Bu cümle deneme süresi başlamadan hiçbir yerde görünmemeli.";

const GATED: Quota = { limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null, trialEligible: true };
const PAYING: Quota = { limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" };

function request(path: string, json?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3141/api/agent/v1${path}`, {
    method: json !== undefined ? "POST" : "GET",
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
}
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  const now = new Date().toISOString();
  const fake = fakeSupabase({
    api_keys: [
      { id: "key-1", account_id: ACCOUNT, name: "cli", scopes: ["read", "generate", "write"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(KEY), created_by: CREATOR },
    ],
    workspaces: [{ id: WS, account_id: ACCOUNT, name: "Acme", domain: "acme-agency.example", status: "on", created_at: now }],
    articles: [
      {
        id: ART,
        workspace_id: WS,
        title: "Ajanslar için rehber",
        slug: "rehber",
        keyword: "ajans rehberi",
        status: "review",
        word_count: 9,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SECRET }] }] },
        created_at: now,
        updated_at: now,
      },
    ],
    publish_log: [],
    generation_jobs: [],
  });
  db = {
    ...fake,
    auth: {
      ...fake.auth,
      admin: { getUserById: async () => ({ data: { user: { id: CREATOR, email: "owner@acme-agency.example" } } }) },
    },
  };
  quota = GATED;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /articles/{id}/content", () => {
  it("refuses an account before its trial, with the reason and no text", async () => {
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    const res = await GET(request(`/articles/${ART}/content?format=markdown`), params({ id: ART }));
    expect(res.status).toBe(403);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    const env = JSON.parse(raw);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("forbidden");
    expect(env.error.message).toBe(BODY_LOCKED_MESSAGE);
    expect(env.agent_guidance).toMatch(/\/onboarding/);
  });

  it("refuses every format, not only Markdown", async () => {
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    for (const format of ["html", "tiptap"]) {
      const res = await GET(request(`/articles/${ART}/content?format=${format}`), params({ id: ART }));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(SECRET);
    }
  });

  it("serves the text to a paying account", async () => {
    quota = PAYING;
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    const res = await GET(request(`/articles/${ART}/content?format=markdown`), params({ id: ART }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.content).toContain(SECRET);
  });

  it("serves it when the kill switch is on, like every other surface", async () => {
    vi.stubEnv("TRIAL_GATE_DISABLED", "1");
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    const res = await GET(request(`/articles/${ART}/content?format=html`), params({ id: ART }));
    expect(res.status).toBe(200);
  });

  it("asks about the account as nobody, never as the key's creator", async () => {
    // Round-5 review: asked as the creator, a key an operator made while
    // invited into a customer's gated account read that account's text for
    // as long as the key lived. Whether the account is ours is answered by
    // who created the account (getQuota with no caller).
    const { getQuota } = await import("@/lib/billing/quota");
    const spy = vi.mocked(getQuota);
    spy.mockClear();
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    const res = await GET(request(`/articles/${ART}/content?format=markdown`), params({ id: ART }));
    expect(res.status).toBe(403);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) expect(call[2]).toBeNull();
  });

  it("serves it to a key made by a bypassed address, asked as the key's creator", async () => {
    vi.stubEnv("TRIAL_GATE_BYPASS_EMAILS", "owner@acme-agency.example");
    const { GET } = await import("@/app/api/agent/v1/articles/[id]/content/route");
    const res = await GET(request(`/articles/${ART}/content?format=html`), params({ id: ART }));
    expect(res.status).toBe(200);
  });
});

describe("find-and-replace previews quote the text, so they are locked too", () => {
  it("POST /articles/{id}/replace refuses before the trial and writes nothing", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/replace/route");
    const res = await POST(request(`/articles/${ART}/replace`, { find: "cümle", replace: "x" }), params({ id: ART }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
    expect(db.writes.filter((w) => w.table === "articles")).toHaveLength(0);
  });

  it("POST /articles/bulk-replace refuses before the trial", async () => {
    const { POST } = await import("@/app/api/agent/v1/articles/bulk-replace/route");
    const res = await POST(request("/articles/bulk-replace", { workspace_id: WS, find: "cümle", replace: "x" }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("POST /articles/{id}/replace still previews for a paying account", async () => {
    quota = PAYING;
    const { POST } = await import("@/app/api/agent/v1/articles/[id]/replace/route");
    const res = await POST(request(`/articles/${ART}/replace`, { find: "cümle", replace: "x" }), params({ id: ART }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.occurrences).toBe(1);
  });
});
