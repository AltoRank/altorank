import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * A draft the platform destroyed is not a draft the customer spent.
 *
 * 2026-09-09: qasimcode.com's sixth run was killed at the function limit
 * before a word was generated. The stale sweeper marked the zero-word row
 * `error`, and the next run said "All 7 free drafts are used" - with five
 * real drafts on the account. Both article counts `getQuota` makes must leave
 * `status = 'error'` out.
 */

vi.mock("@/lib/billing/account-client", () => ({ accountCountingClient: (c: unknown) => c }));
vi.mock("@/lib/auth/admin", () => ({ isAdminEmail: () => false }));
vi.mock("@/lib/billing/operator-account", () => ({ accountHasOperator: async () => false }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/billing/operator-preview", () => ({
  inCustomerPreview: async () => false,
  getOperatorPreview: async () => null,
}));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_quota_errored";
});

/** Records every filter applied to each `articles` query. */
function recordingClient(account: Record<string, unknown>) {
  const articleQueries: string[][] = [];
  const chain = (name: string): Record<string, unknown> => {
    const filters: string[] = [];
    if (name === "articles") articleQueries.push(filters);
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "neq", "gte", "lt", "order", "limit"]) {
      q[m] = (...a: unknown[]) => {
        filters.push(`${m}(${a.map((x) => (typeof x === "string" ? x : "…")).join(",")})`);
        return q;
      };
    }
    q.single = async () => ({ data: name === "accounts" ? account : null, error: null });
    q.maybeSingle = async () => ({ data: name === "accounts" ? account : null, error: null });
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve(name === "workspaces" ? { data: [{ id: "w1" }], count: 1, error: null } : { data: [], count: 5, error: null });
    return q;
  };
  return {
    client: { from: (n: string) => chain(n), auth: { getUser: async () => ({ data: { user: { email: "o@x.test" } } }) } },
    articleQueries,
  };
}

describe("getQuota leaves the platform's own failures out of the count", () => {
  it("excludes errored drafts from both the monthly and the lifetime count", async () => {
    const { getQuota } = await import("../quota");
    const { client, articleQueries } = recordingClient({ plan: null, plan_status: null, free_drafts_used: 0 });
    await getQuota(client as never, "ag1", "o@x.test");
    expect(articleQueries.length).toBeGreaterThanOrEqual(2);
    for (const filters of articleQueries) {
      expect(filters).toContain("neq(status,error)");
    }
  });
});
