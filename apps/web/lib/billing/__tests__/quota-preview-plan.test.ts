import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// The Operations preview offers "No plan", "Managed" and "Agency" and says the
// quota and plan gates are applied as a customer's would be. The choice used
// to reach only the banner and the Billing page; getQuota now renders the
// gates for it - for an operator's own session only, because a plan is a
// grant and the preview cookie is unsigned.

const state = vi.hoisted(() => ({ operator: true, previewing: true, plan: "growth" as string | null | undefined }));

vi.mock("@/lib/billing/account-client", () => ({ accountCountingClient: (c: unknown) => c }));
vi.mock("@/lib/auth/operators", () => ({ isAdminEmail: () => state.operator }));
vi.mock("@/lib/billing/operator-account", () => ({ accountHasOperator: async () => true }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/auth/preview", () => ({
  inCustomerPreview: async () => state.previewing,
  customerPreviewPlan: async () => (state.previewing ? state.plan : undefined),
}));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_quota_preview_plan";
});
beforeEach(() => {
  state.operator = true;
  state.previewing = true;
  state.plan = "growth";
});

/** An operator's own account: no plan, three articles this month. */
function client() {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    in: () => q,
    neq: () => q,
    gte: () => q,
    maybeSingle: () => Promise.resolve({ data: { plan: "starter", plan_status: null, free_drafts_used: 2 }, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: "w1" }], count: 3, error: null }),
  };
  return { from: () => q, auth: { getUser: async () => ({ data: { user: { email: "op@example.test" } } }) } };
}

describe("getQuota in a customer preview", () => {
  it("renders the gates for the plan the operator picked", async () => {
    const { getQuota } = await import("../quota");
    const { PLAN_ARTICLE_LIMITS } = await import("@/lib/stripe");
    const q = await getQuota(client() as never, "acc-1", "op@example.test");
    expect(q.reason).toBe("plan");
    expect(q.plan).toBe("growth");
    expect(q.limit).toBe(PLAN_ARTICLE_LIMITS.growth);
  });

  it("renders the free tier for 'No plan'", async () => {
    state.plan = null;
    const { getQuota } = await import("../quota");
    const q = await getQuota(client() as never, "acc-1", "op@example.test");
    expect(q.reason).toBe("no-plan");
    expect(q.plan).toBeNull();
  });

  it("ignores the cookie for anyone who is not an operator", async () => {
    state.operator = false;
    const { getQuota } = await import("../quota");
    const q = await getQuota(client() as never, "acc-1", "someone@example.test");
    expect(q.plan).not.toBe("growth");
  });

  it("is the operator bypass again once the preview ends", async () => {
    state.previewing = false;
    const { getQuota } = await import("../quota");
    const q = await getQuota(client() as never, "acc-1", "op@example.test");
    expect(q.reason).toBe("operator");
  });
});
