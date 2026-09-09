import { describe, it, expect, vi, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// A refusal derived from a failed read is not a refusal
// ---------------------------------------------------------------------------
//
// `getQuota` dropped the error from its `agencies` read and fell through to
// `planEntitled({})`, which is false. So a transient failure demoted a paying
// customer to the free tier for the length of the request - and that answer is
// what the sidebar usage bar, the Keywords rank-tracking banner, the
// New-article gate and the calendar's write gate are all built on. The worst
// of it is the copy: the account is told to buy the plan it already has.
//
// The `workspaces` read had the milder version of the same fault: its error
// became an empty id list, which became `used = 0` - a measurement, from a
// read that did not happen.

vi.mock("@/lib/billing/agency-client", () => ({
  agencyCountingClient: (c: unknown) => c,
}));
vi.mock("@/lib/auth/admin", () => ({ isAdminEmail: () => false }));
vi.mock("@/lib/billing/operator-agency", () => ({ agencyHasOperator: async () => false }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/billing/operator-preview", () => ({
  inCustomerPreview: async () => false,
  getOperatorPreview: async () => null,
}));

// `getQuota` returns "self-host" before it ever reads the agency row when
// Stripe is unconfigured, which is every test process by default. The paths
// under test are the metered ones.
beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_quota_read_failure";
});

const FAILURE = { message: "connection terminated unexpectedly" };

/** A client whose named table fails and whose others answer normally. */
function clientFailingOn(table: string) {
  const chain = (name: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      neq: () => q,
      gte: () => q,
      single: () => Promise.resolve(name === table ? { data: null, error: FAILURE } : { data: { plan: "managed", plan_status: "active" }, error: null }),
      maybeSingle: () => Promise.resolve(name === table ? { data: null, error: FAILURE } : { data: { plan: "managed", plan_status: "active" }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve(
          name === table
            ? { data: null, count: null, error: FAILURE }
            : { data: [{ id: "w1" }], count: 3, error: null },
        ),
    };
    return q;
  };
  return {
    from: (name: string) => chain(name),
    auth: { getUser: async () => ({ data: { user: { email: "owner@example.test" } } }) },
  };
}

describe("getQuota with a read it could not make", () => {
  it("refuses to answer rather than calling a paying account free", async () => {
    const { getQuota } = await import("../quota");
    await expect(getQuota(clientFailingOn("agencies") as never, "ag1", "owner@example.test")).rejects.toThrow(
      /could not read this account's plan/,
    );
  });

  it("refuses to report usage it could not count", async () => {
    const { getQuota } = await import("../quota");
    await expect(getQuota(clientFailingOn("workspaces") as never, "ag1", "owner@example.test")).rejects.toThrow(
      /could not read this account's sites/,
    );
  });

  it("still answers normally when every read succeeds", async () => {
    const { getQuota } = await import("../quota");
    const quota = await getQuota(clientFailingOn("nothing") as never, "ag1", "owner@example.test");
    expect(quota.reason).not.toBe("no-plan");
    expect(quota.used).toBe(3);
  });
});
