import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

/**
 * The publisher asks the trial gate with whatever client it was handed, and
 * the Publish button hands it the person's cookie client. That client cannot
 * read auth.users, so the operator lookup behind a session-less quota read
 * failed there, answered "not an operator", and cached it: our own account
 * (no plan by design) came out gated on Publish, and every service-role cron
 * after it in the same process agreed (round-4 review).
 *
 * The real chain runs here: workspaceTrialGate -> accountTrialGate ->
 * getQuota -> accountHasOperator. Only the two clients are stand-ins.
 */

const OPERATOR = "operator@acme-agency.example";

type Rows = Record<string, unknown[]>;

/** A chainable PostgREST stand-in over fixed rows, with an admin API or not. */
function fakeClient(rows: Rows, opts: { admin: boolean }) {
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "neq", "gte", "lt", "order", "limit", "is"]) q[m] = () => q;
    const data = rows[table] ?? [];
    q.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
    q.single = async () => ({ data: data[0] ?? null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data, count: 0, error: null });
    return q;
  };
  return {
    from: (table: string) => query(table),
    auth: {
      getUser: async () => ({ data: { user: null } }),
      admin: {
        getUserById: async () =>
          opts.admin
            ? { data: { user: { email: OPERATOR } }, error: null }
            : { data: { user: null }, error: { message: "User not allowed" } },
      },
    },
  };
}

const rows: Rows = {
  workspaces: [{ id: "w1", account_id: "a1" }],
  account_members: [{ user_id: "u1" }],
  // No plan, never trialed: gated, unless the account is ours.
  // Created by an operator (migration 101 records it): that, not who the
  // members are, is what makes it ours.
  accounts: [{ plan: null, plan_status: null, free_drafts_used: 0, trial_ends_at: null, stripe_subscription_id: null, created_by: "u1" }],
  articles: [],
};

const service = fakeClient(rows, { admin: true });
const cookie = fakeClient(rows, { admin: false });

vi.mock("@/lib/billing/account-client", () => ({ accountCountingClient: () => service }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/auth/preview", () => ({ inCustomerPreview: async () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => cookie }));
vi.mock("@/lib/queries/quota", () => ({ getRequestQuota: async () => null }));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_body_lock_operator";
  process.env.ADMIN_EMAILS = OPERATOR;
  delete process.env.TRIAL_GATE_DISABLED;
});

beforeEach(async () => {
  const { clearOperatorAccountCache } = await import("../operator-account");
  clearOperatorAccountCache();
});

describe("the publisher's trial gate on an operator account", () => {
  it("is open on the Publish button's cookie client", async () => {
    const { workspaceTrialGate } = await import("../body-lock");
    expect(await workspaceTrialGate(cookie as never, "w1")).toBe("open");
  });

  it("is open on the cron's service client", async () => {
    const { workspaceTrialGate } = await import("../body-lock");
    expect(await workspaceTrialGate(service as never, "w1")).toBe("open");
  });

  it("stays open for the service client after a cookie-client call in the same process", async () => {
    const { workspaceTrialGate } = await import("../body-lock");
    await workspaceTrialGate(cookie as never, "w1");
    expect(await workspaceTrialGate(service as never, "w1")).toBe("open");
  });
});

describe("one answer for the account, whoever asks", () => {
  // Round-4 review: the agent API's content lock asks as the key's creator,
  // and its generate route asks as nobody. With the account check made only
  // for "nobody", a key created by a colleague on our own account was locked
  // out of the text while the same key drafted freely.
  it("is open for a key created by a non-operator member of an account an operator created", async () => {
    const { accountTrialGate } = await import("../body-lock");
    const { getQuota } = await import("../quota");
    expect(await accountTrialGate(service as never, "a1", "colleague@acme-agency.example")).toBe("open");
    expect((await getQuota(service as never, "a1", null)).reason).toBe("operator");
    expect((await getQuota(service as never, "a1", "colleague@acme-agency.example")).reason).toBe("operator");
  });
});
