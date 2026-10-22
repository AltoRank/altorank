import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// The return from checkout records the checkout itself, when it should
// ---------------------------------------------------------------------------
//
// The page used to wait for Stripe's webhook and nothing else: with no webhook
// the person was told "taking longer than expected" and stayed on the free
// plan while Stripe held their trial. These pin when the return page writes
// (a complete session of this account, a running subscription, an account not
// yet carrying it) and, as much, when it must not. The write itself is
// lib/billing/activate-checkout.ts, tested on the database next to it.

const ACCOUNT = "account-1";

let account: Record<string, unknown> | null = null;
const reads: string[] = [];
const services: unknown[] = [];

vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: ACCOUNT }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            reads.push("account");
            return { data: account, error: null };
          },
        }),
      }),
    }),
  }),
  createServiceClient: () => {
    const client = { service: true };
    services.push(client);
    return client;
  },
}));

const { retrieveSession, retrieveSubscription, activate, recorded } = vi.hoisted(() => ({
  retrieveSession: vi.fn(),
  retrieveSubscription: vi.fn(),
  activate: vi.fn(),
  recorded: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getStripe: () => ({ checkout: { sessions: { retrieve: retrieveSession } } }),
}));
vi.mock("@/lib/billing/activate-checkout", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readCheckoutSubscription: (...a: unknown[]) => retrieveSubscription(...a),
  activateCheckout: (...a: unknown[]) => activate(...a),
}));
vi.mock("@/lib/observability/record", () => ({ recordEvent: (...a: unknown[]) => recorded(...a) }));

const TRIAL_END = Math.floor(Date.now() / 1000) + 7 * 86_400;

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_1",
    status: "complete",
    client_reference_id: ACCOUNT,
    customer: "cus_1",
    subscription: "sub_1",
    metadata: { account_id: ACCOUNT, plan: "starter", interval: "month" },
    ...overrides,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return { id: "sub_1", customer: "cus_1", status: "trialing", trial_end: TRIAL_END, metadata: { account_id: ACCOUNT }, items: { data: [] }, ...overrides };
}

async function poll(id = "cs_test_1") {
  const { GET } = await import("../route");
  const res = await GET(new NextRequest(`https://app.altorank.co/api/billing/checkout-status?session_id=${id}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  account = { stripe_subscription_id: null, plan_status: "inactive", trial_ends_at: null };
  reads.length = 0;
  services.length = 0;
  retrieveSession.mockReset().mockResolvedValue(session());
  retrieveSubscription.mockReset().mockResolvedValue(subscription());
  recorded.mockClear();
  // The write lands: the account reads back as trialing on this subscription.
  activate.mockReset().mockImplementation(async () => {
    account = { stripe_subscription_id: "sub_1", plan_status: "trialing", trial_ends_at: new Date(TRIAL_END * 1000).toISOString() };
    return { recorded: true, trialEndsAt: account.trial_ends_at, plan: "starter", paced: 1, owed: 1 };
  });
});

describe("a completed checkout the webhook has not recorded yet", () => {
  it("is recorded from the subscription Stripe has, as AltoRank, and answers active on the same poll", async () => {
    const { status, body } = await poll();
    expect(status).toBe(200);
    expect(body).toEqual({ status: "complete", active: true });
    // Re-read from Stripe, not taken from the session.
    expect(retrieveSubscription).toHaveBeenCalledWith("sub_1");
    expect(activate).toHaveBeenCalledTimes(1);
    const [client, input] = activate.mock.calls[0];
    expect(client).toBe(services[0]);
    expect(input).toMatchObject({ accountId: ACCOUNT, customerId: "cus_1", subscription: { id: "sub_1", status: "trialing" } });
    expect(input.hints).toMatchObject({ plan: "starter" });
    // Read before, and again after the write.
    expect(reads).toEqual(["account", "account"]);
  });

  it("says so where an operator looks, so a webhook that never arrives is visible", async () => {
    await poll();
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0][0]).toMatchObject({ source: "billing.checkout", level: "info", accountId: ACCOUNT, context: { subscription: "sub_1" } });
  });

  it("records nothing of its own when the webhook got there in between", async () => {
    activate.mockImplementation(async () => {
      account = { stripe_subscription_id: "sub_1", plan_status: "trialing", trial_ends_at: new Date(TRIAL_END * 1000).toISOString() };
      return { recorded: false, trialEndsAt: account.trial_ends_at, plan: "starter", paced: 0, owed: 0 };
    });
    const { body } = await poll();
    expect(body.active).toBe(true);
    expect(recorded).not.toHaveBeenCalled();
  });

  it("records a plan bought outright, as for a returning customer whose old plan ended", async () => {
    account = { stripe_subscription_id: "sub_old", plan_status: "canceled", trial_ends_at: "2026-01-01T00:00:00Z" };
    retrieveSubscription.mockResolvedValue(subscription({ status: "active", trial_end: null }));
    await poll();
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe("when the return page leaves the account alone", () => {
  it("does not write once the account carries this subscription, and reads nothing from Stripe for it", async () => {
    account = { stripe_subscription_id: "sub_1", plan_status: "trialing", trial_ends_at: new Date(TRIAL_END * 1000).toISOString() };
    const { body } = await poll();
    expect(body.active).toBe(true);
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not replace another subscription that is still live", async () => {
    account = { stripe_subscription_id: "sub_other", plan_status: "active", trial_ends_at: null };
    const { body } = await poll();
    expect(body.active).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not write for a session that has not completed", async () => {
    for (const status of ["open", "expired"]) {
      retrieveSession.mockResolvedValue(session({ status, subscription: null }));
      const { body } = await poll();
      expect(body).toEqual({ status, active: false });
    }
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not write for another account's checkout", async () => {
    retrieveSession.mockResolvedValue(session({ client_reference_id: "account-2" }));
    const { status } = await poll();
    expect(status).toBe(404);
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not write when the subscription names another account", async () => {
    retrieveSubscription.mockResolvedValue(subscription({ metadata: { account_id: "account-2" } }));
    const { body } = await poll();
    expect(body.active).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves a subscription that is not running yet to the webhook", async () => {
    for (const status of ["incomplete", "incomplete_expired", "past_due", "canceled", "paused"]) {
      retrieveSubscription.mockResolvedValue(subscription({ status }));
      const { body } = await poll();
      expect(body.active).toBe(false);
    }
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("a failure on the way", () => {
  it("answers 503 when the subscription cannot be read, so the page asks again", async () => {
    retrieveSubscription.mockRejectedValue(new Error("could not read subscription sub_1"));
    const { status, body } = await poll();
    expect(status).toBe(503);
    expect(body.error).toMatch(/retry/);
    expect(activate).not.toHaveBeenCalled();
  });

  it("answers 503 when the write fails, rather than active", async () => {
    activate.mockRejectedValue(new Error("could not record the subscription on the account"));
    const { status } = await poll();
    expect(status).toBe(503);
  });

  it("refuses a malformed session id before reaching Stripe", async () => {
    const { status } = await poll("sub_1");
    expect(status).toBe(400);
    expect(retrieveSession).not.toHaveBeenCalled();
  });
});
