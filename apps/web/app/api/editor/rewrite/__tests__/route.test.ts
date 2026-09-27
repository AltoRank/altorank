import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/editor/rewrite: the editor's whole-article rewrite
// ---------------------------------------------------------------------------
//
// It takes an article's text and streams a model's rewrite of it back, so it
// is the editor, and the editor is what the trial opens. It was the one
// editor door with no body lock, and it billed whichever account the person
// joined first rather than the article's.

const locked = vi.fn<(workspaceId: string) => Promise<boolean>>();
vi.mock("@/lib/billing/body-lock", () => ({ sessionBodyLockedForWorkspace: (id: string) => locked(id) }));

const canSpend = vi.fn();
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: (...args: unknown[]) => canSpend(...args) }));

const stream = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { stream: (...a: unknown[]) => stream(...a) }; } }));

const rows: Record<string, Record<string, unknown>> = {
  articles: { id: "a1", title: "T", keyword: "k", workspace_id: "ws-b" },
  workspaces: { account_id: "acc-b" },
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "person@acme-agency.example" } }, error: null }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: rows[table] ?? null }),
        maybeSingle: async () => ({ data: rows[table] ?? null }),
      };
      return chain;
    },
  }),
}));

const { POST } = await import("../route");

const post = () =>
  new NextRequest("http://localhost/api/editor/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ articleId: "a1", html: "<p>Some text.</p>", instruction: "tighten" }),
  });

beforeEach(() => {
  locked.mockReset();
  canSpend.mockReset();
  stream.mockReset();
});

describe("POST /api/editor/rewrite", () => {
  it("refuses an account that has not started its trial, before any model call", async () => {
    locked.mockResolvedValue(true);
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "trial_required" });
    expect(locked).toHaveBeenCalledWith("ws-b");
    expect(canSpend).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("asks the spend gate about the article's account, not the person's first one", async () => {
    locked.mockResolvedValue(false);
    canSpend.mockResolvedValue({ allowed: false, reason: "no-plan", message: "needs a plan" });
    const res = await POST(post());
    expect(res.status).toBe(402);
    expect(canSpend).toHaveBeenCalledWith(expect.anything(), "acc-b", expect.objectContaining({ workspaceId: "ws-b" }));
    expect(stream).not.toHaveBeenCalled();
  });
});
