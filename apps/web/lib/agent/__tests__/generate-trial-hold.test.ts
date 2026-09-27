/**
 * POST /articles/generate (and the hosted MCP tool `altorank_generate_draft`,
 * which calls it) under the trial hold: an account that must start its trial
 * first has its one article, and an agent asking for another gets a refusal it
 * can relay - before any row exists, so it is never handed a draft id that can
 * only turn into `error`. Real auth, real handler, fake database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/agent/api-keys";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
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

const ACCOUNT = "account-1";
const WS = "11111111-1111-4111-8111-111111111111";
const FIRST = "33333333-3333-4333-8333-333333333333";
const KEY = "altorank_live_" + "H".repeat(40);

function seed(): Seed {
  const now = new Date().toISOString();
  return {
    api_keys: [{ id: "key-gen", account_id: ACCOUNT, name: "gen", scopes: ["read", "generate"], expires_at: null, revoked_at: null, last_used_at: now, key_hash: hashApiKey(KEY) }],
    workspaces: [{ id: WS, account_id: ACCOUNT, name: "Acme", domain: "acme-agency.example", status: "on", ai_provider: "claude", created_at: now }],
    articles: [{ id: FIRST, workspace_id: WS, title: "The first article", keyword: "crm for agencies", status: "review", created_at: now }],
    keywords: [],
    agent_idempotency_keys: [],
  };
}

function generate(json: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost:3132/api/agent/v1/articles/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: WS, keyword: "crm pricing for agencies", ...json }),
  });
}

const gated = (used: number) => ({ limit: 7, used, remaining: 7 - used, reason: "no-plan", plan: null, trialEligible: true });
const drafts = () => db.tables.articles.filter((a) => a.workspace_id === WS);

beforeEach(() => {
  delete process.env.TRIAL_GATE_DISABLED;
  db = fakeSupabase(seed());
  afterCalls.length = 0;
  quota.mockReset();
});

describe("POST /articles/generate and the trial hold", () => {
  it("refuses a second draft before the trial, with the hold's words and guidance to relay, and writes no row", async () => {
    quota.mockResolvedValue(gated(1));
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const res = await POST(generate({ idempotency_key: "k-held" }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_available");
    expect(body.error.message).toMatch(/^Waiting for your trial to start\./);
    expect(body.agent_guidance).toMatch(/trial/);
    expect(drafts()).toHaveLength(1);
    expect(afterCalls).toHaveLength(0);
    // The key is released: the same call works once the trial has started.
    expect(db.tables.agent_idempotency_keys).toHaveLength(0);
  });

  it("refuses to regenerate the first article before the trial, in the body lock's words", async () => {
    // It adds no draft, so the hold let it through, and every call bought the
    // research, the model call and the fact check again. The session door
    // refused the same request; the text is what the trial opens.
    quota.mockResolvedValue(gated(1));
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const res = await POST(generate({ article_id: FIRST }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe(BODY_LOCKED_MESSAGE);
    expect(afterCalls).toHaveLength(0);
  });

  it("lets a paying account regenerate in place", async () => {
    quota.mockResolvedValue({ limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" });
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    const res = await POST(generate({ article_id: FIRST }));
    expect(res.status).toBe(202);
    expect(afterCalls).toHaveLength(1);
  });

  it("writes for a trialing account", async () => {
    quota.mockResolvedValue({ limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" });
    const { POST } = await import("@/app/api/agent/v1/articles/generate/route");
    expect((await POST(generate())).status).toBe(202);
    expect(drafts()).toHaveLength(2);
  });
});
