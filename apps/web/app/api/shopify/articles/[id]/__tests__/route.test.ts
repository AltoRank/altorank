import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  readArticlesWhole: vi.fn(),
  accountTrialGate: vi.fn(),
  needsPlanToShip: vi.fn(),
}));
vi.mock("@/lib/articles/body-read", () => ({ readArticlesWhole: m.readArticlesWhole }));
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: m.accountTrialGate }));
vi.mock("@/lib/billing/quota", () => ({ needsPlanToShip: m.needsPlanToShip, CHOOSE_PLAN_MESSAGE: "Choose a plan" }));
vi.mock("@/lib/billing/trial-refusal", () => ({ BODY_LOCKED_MESSAGE: "Locked until the trial starts" }));
vi.mock("@/lib/cms/html", () => ({ tiptapToHtml: () => "<h1>Body</h1>" }));

const ROWS = [
  { id: "a1", workspace_id: "ws-1", title: "Mine", keyword: "k", status: "review" },
  { id: "a2", workspace_id: "ws-OTHER", title: "Theirs", keyword: "k", status: "review" },
];
vi.mock("@/lib/shopify/request-auth", () => ({
  authenticateLinkedShop: async () => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => ((filters[c] = v), chain),
      maybeSingle: async () => ({
        data: ROWS.find((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null,
      }),
    };
    return {
      ok: true,
      ctx: { supabase: { from: () => chain }, installation: { id: "inst-1", accountId: "acc-1", workspaceId: "ws-1" } },
    };
  },
}));

import { GET } from "../route";

const get = (id: string) => GET(new Request(`https://x/api/shopify/articles/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.accountTrialGate.mockResolvedValue("open");
  m.needsPlanToShip.mockResolvedValue(false);
  m.readArticlesWhole.mockResolvedValue([{ id: "a1", content: { type: "doc" } }]);
});

describe("GET /api/shopify/articles/:id", () => {
  it("serves an article on the store's own site", async () => {
    const body = await (await get("a1")).json();
    expect(body).toMatchObject({ id: "a1", html: "<h1>Body</h1>", canApprove: true });
  });

  it("is a 404 for an article on any other site, and reads no body", async () => {
    expect((await get("a2")).status).toBe(404);
    expect(m.readArticlesWhole).not.toHaveBeenCalled();
  });

  it("shows the lock, not the body, while the account is gated", async () => {
    m.accountTrialGate.mockResolvedValue("gated");
    const body = await (await get("a1")).json();
    expect(body.html).toContain("Locked until the trial starts");
    expect(body.canApprove).toBe(false);
    expect(m.readArticlesWhole).not.toHaveBeenCalled();
  });
});
