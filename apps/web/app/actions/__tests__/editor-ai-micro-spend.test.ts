/**
 * The editor's quick rewrites (a title, a meta description, a selection):
 * a model call per press that wrote no spend row and had no limit. Pinned
 * here: the row is written with the article and its site, each press is
 * counted against the site's account, and a refused press buys nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ARTICLE = "33333333-3333-4333-8333-333333333333";

function client() {
  const one = (data: unknown) => {
    const q: Record<string, unknown> = { select: () => q, eq: () => q, single: async () => ({ data, error: null }), maybeSingle: async () => ({ data, error: null }) };
    return q;
  };
  return { from: () => one({ id: "ws1", account_id: "acc-site", domain: "acme-agency.example", brand_style: null }) };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client(), createServiceClient: () => client() }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ user: { id: "u1", email: "owner@acme-agency.example" }, accountId: "acc-first", role: "owner" }) }));
vi.mock("@/lib/billing/body-lock", () => ({
  sessionBodyLockedForWorkspace: async () => false,
  articleBodyForSession: async () => ({ id: ARTICLE, workspace_id: "ws1", title: "Guide", keyword: "agency seo", slug: "guide", meta_description: null, featured_image_url: null, published_at: null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const canSpend = vi.fn();
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: (...a: unknown[]) => canSpend(...a) }));
const takeDoor = vi.fn();
vi.mock("@/lib/billing/spend-doors", () => ({ takeDoor: (...a: unknown[]) => takeDoor(...a) }));

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: (...a: unknown[]) => create(...a) }; } }));

const rows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/billing/default-spend", async () => {
  const { currentSpendScope } = await import("@/lib/billing/spend-scope");
  return {
    spendClient: () => null,
    recordSpendByDefault: (entry: Record<string, unknown>) => {
      const s = currentSpendScope();
      rows.push({ ...entry, workspaceId: s?.workspaceId, articleId: s?.articleId });
    },
  };
});

const press = async () => {
  const { rewriteFieldAction } = await import("../editor-ai");
  return rewriteFieldAction({ articleId: ARTICLE, field: "title", action: "shorten", text: "A long title about agency SEO" });
};

beforeEach(() => {
  rows.length = 0;
  canSpend.mockReset().mockResolvedValue({ allowed: true, reason: "plan", message: null });
  takeDoor.mockReset().mockResolvedValue({ allowed: true, useId: null });
  create.mockReset().mockResolvedValue({ content: [{ type: "text", text: "Agency SEO guide" }], usage: { input_tokens: 300, output_tokens: 12 } });
});

describe("rewriteFieldAction", () => {
  it("writes a spend row for the call, with the article and its site", async () => {
    const res = await press();
    expect(res).toEqual({ ok: true, text: "Agency SEO guide" });
    expect(rows).toEqual([
      expect.objectContaining({ provider: "anthropic", operation: "editor/micro", inputTokens: 300, outputTokens: 12, workspaceId: "ws1", articleId: ARTICLE }),
    ]);
  });

  it("counts the press against the site's account", async () => {
    await press();
    expect(takeDoor).toHaveBeenCalledWith("editor-micro", { accountId: "acc-site", workspaceId: "ws1" });
  });

  it("refuses past the limit and buys nothing", async () => {
    takeDoor.mockResolvedValue({ allowed: false, message: "This account has used its quick rewrites for now: 120 an hour. Try again within the hour." });
    const res = await press();
    expect(res).toEqual({ ok: false, error: expect.stringContaining("120 an hour") });
    expect(create).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("does not count a self-hosted install", async () => {
    canSpend.mockResolvedValue({ allowed: true, reason: "self-host", message: null });
    await press();
    expect(takeDoor).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
