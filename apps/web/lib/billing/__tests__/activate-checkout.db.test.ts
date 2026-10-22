// ---------------------------------------------------------------------------
// A checkout recorded by whichever door gets there first, on the local
// database
// ---------------------------------------------------------------------------
//
// Two doors record a completed checkout: Stripe's signed webhook and the page
// the buyer returns to (app/api/billing/checkout-status). The promise is that
// it does not matter which arrives first, or whether both arrive at once:
// the account is written once, each site is raised and owed its follow-up
// once, the follow-up is handed off once, and one trial-started email goes
// out. Only Postgres can show that, because "once" rests on conditional
// updates being re-checked after a concurrent writer commits, and on the
// unique keys under `sent_emails` and the funnel's events.
//
// The real routes and the real `activateCheckout` run against the local
// stack. Stripe is a stub that answers with the session and the subscription
// set up here (the signature is checked locally, with a dummy key that never
// leaves the process); the mail provider and the follow-up hand-off are
// counted, not called. Seeds one account per case with invented names and
// deletes them at the end.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { connectLocalStack } from "@/lib/__tests__/support/local-db";
import type { ActivationOutcome } from "@/lib/billing/activate-checkout";

process.env.STRIPE_SECRET_KEY = "sk_test_dummy_never_sent";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_activate_checkout_test";
process.env.STRIPE_PRICE_GROWTH = "price_test_growth_month";
// Self-invocation off: the email says only what the plan opens, and nothing
// here tries to call the app over HTTP.
delete process.env.CRON_SECRET;

/** `after()` needs a request scope; here it queues, and `settle()` runs the queue. */
const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<() => unknown> }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: (fn: () => unknown) => {
    deferred.push(fn);
  },
}));
async function settle() {
  while (deferred.length) await deferred.shift()!();
}

/** What Stripe answers: the sessions and subscriptions each case sets up. */
const { sessions, subscriptions } = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  subscriptions: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  const webhooks = new Stripe("sk_test_dummy_never_sent").webhooks;
  const found = (map: Map<string, Record<string, unknown>>, id: string) => {
    const value = map.get(id);
    if (!value) throw new Error(`No such object: ${id}`);
    return structuredClone(value);
  };
  return {
    ...actual,
    getStripe: () => ({
      webhooks,
      checkout: { sessions: { retrieve: async (id: string) => found(sessions, id) } },
      subscriptions: { retrieve: async (id: string) => found(subscriptions, id) },
    }),
  };
});

/** The signed-in account for the return page; the cookie client is the service client here. */
const { signedIn } = vi.hoisted(() => ({ signedIn: { accountId: "" } }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: signedIn.accountId }) }));
vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return { ...actual, createClient: async () => actual.createServiceClient() };
});

/** The mail provider, counted: `sendOnce` and its ledger are the real ones. */
const { mailed } = vi.hoisted(() => ({ mailed: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/lib/email/resend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendTransactionalEmail: (...a: unknown[]) => mailed(...a),
}));

/** The follow-up hand-off, counted. */
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/lib/plan/resume-dispatch", () => ({ dispatchResume: (...a: unknown[]) => dispatched(...a) }));

/** Every activation's own account of what it wrote, whichever door ran it. */
const { outcomes } = vi.hoisted(() => ({ outcomes: [] as ActivationOutcome[] }));
vi.mock("@/lib/billing/activate-checkout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/activate-checkout")>();
  return {
    ...actual,
    activateCheckout: async (...a: Parameters<typeof actual.activateCheckout>) => {
      const outcome = await actual.activateCheckout(...a);
      outcomes.push(outcome);
      return outcome;
    },
  };
});

const STACK = await connectLocalStack();

const { createServiceClient } = await import("@/lib/supabase/server");
const { activateCheckout, readCheckoutSubscription } = await import("@/lib/billing/activate-checkout");
const { POST: webhook } = await import("@/app/api/webhooks/stripe/route");
const { GET: checkoutStatus } = await import("@/app/api/billing/checkout-status/route");

const RUN = `activate-${Date.now().toString(36)}`;
const TRIAL_END_S = Math.floor(Date.now() / 1000) + 7 * 86_400;
const TRIAL_END = new Date(TRIAL_END_S * 1000).toISOString();

type Seeded = { accountId: string; userId: string; workspaceIds: string[]; session: string; subscription: string };
const seeded: Seeded[] = [];

describe.skipIf(!STACK)("a completed checkout, recorded once whoever arrives first", () => {
  let db: ReturnType<typeof createServiceClient>;

  beforeAll(() => {
    db = createServiceClient();
  });

  afterAll(async () => {
    if (!db) return;
    for (const s of seeded) {
      await db.from("system_events").delete().eq("account_id", s.accountId);
      await db.from("system_events").delete().in("workspace_id", s.workspaceIds);
      await db.from("sent_emails").delete().eq("account_id", s.accountId);
      await db.from("workspaces").delete().eq("account_id", s.accountId);
      await db.from("account_members").delete().eq("account_id", s.accountId);
      await db.from("accounts").delete().eq("id", s.accountId);
      await db.auth.admin.deleteUser(s.userId);
    }
  }, 60_000);

  /**
   * One gated account with an owner and two sites - one at the signup pace,
   * which a trial raises, and one somebody set to 2, which it leaves - and a
   * complete checkout for it at Stripe, with a trialing Agency subscription.
   */
  async function seed(name: string, account: Record<string, unknown> = {}): Promise<Seeded> {
    const tag = `${RUN}-${name}`;
    const { data: user, error: userError } = await db.auth.admin.createUser({ email: `owner-${tag}@acme-agency.example`, email_confirm: true });
    if (userError || !user.user) throw new Error(`user: ${userError?.message}`);
    const { data: row, error } = await db
      .from("accounts")
      .insert({ name: `Acme Agency (${tag})`, slug: tag, plan: "starter", plan_status: "inactive", ...account })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const accountId = row.id as string;
    const s: Seeded = { accountId, userId: user.user.id, workspaceIds: [], session: `cs_test_${tag.replace(/-/g, "_")}`, subscription: `sub_test_${tag.replace(/-/g, "_")}` };
    seeded.push(s);
    const { error: memberError } = await db.from("account_members").insert({ account_id: accountId, user_id: s.userId, role: "owner" });
    if (memberError) throw new Error(`member: ${memberError.message}`);
    for (const [n, pace] of [[1, 7], [2, 2]] as const) {
      const { data: ws, error: wsError } = await db
        .from("workspaces")
        .insert({ account_id: accountId, name: `acme-${tag}-${n}.example`, domain: `acme-${tag}-${n}.example`, auto_generate_weekly_limit: pace })
        .select("id")
        .single();
      if (wsError) throw new Error(wsError.message);
      s.workspaceIds.push(ws.id as string);
    }
    const metadata = { account_id: accountId, plan: "growth", interval: "month" };
    subscriptions.set(s.subscription, {
      id: s.subscription,
      object: "subscription",
      customer: `cus_${tag}`,
      status: "trialing",
      trial_end: TRIAL_END_S,
      metadata,
      items: { data: [{ price: { id: "price_test_growth_month", recurring: { interval: "month" } } }] },
    });
    sessions.set(s.session, {
      id: s.session,
      object: "checkout.session",
      status: "complete",
      client_reference_id: accountId,
      customer: `cus_${tag}`,
      subscription: s.subscription,
      metadata,
    });
    return s;
  }

  /** Stripe's `checkout.session.completed`, signed, to the real webhook. */
  async function deliverWebhook(s: Seeded): Promise<Response> {
    const payload = JSON.stringify({
      id: `evt_${s.session}_${Math.random().toString(36).slice(2)}`,
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: sessions.get(s.session) },
    });
    const header = new Stripe("sk_test_dummy_never_sent").webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    return webhook(new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: payload }));
  }

  /** One poll of the return page, signed in as the account. */
  async function pollReturn(s: Seeded): Promise<{ status: number; body: { active?: boolean; error?: string } }> {
    signedIn.accountId = s.accountId;
    const res = await checkoutStatus(new NextRequest(`http://localhost/api/billing/checkout-status?session_id=${s.session}`));
    return { status: res.status, body: await res.json() };
  }

  function reset() {
    outcomes.length = 0;
    deferred.length = 0;
    mailed.mockClear();
    dispatched.mockClear();
  }

  /** Everything a checkout leaves behind, and that each of it happened once. */
  async function expectRecordedOnce(s: Seeded) {
    await settle();

    const { data: account } = await db.from("accounts").select("plan, plan_status, trial_ends_at, stripe_customer_id, stripe_subscription_id").eq("id", s.accountId).single();
    expect(account).toMatchObject({ plan: "growth", plan_status: "trialing", stripe_subscription_id: s.subscription, stripe_customer_id: expect.stringMatching(/^cus_/) });
    expect(Date.parse(account!.trial_ends_at as string)).toBe(Date.parse(TRIAL_END));

    // One door's write landed; every other matched no row.
    expect(outcomes.filter((o) => o.recorded)).toHaveLength(1);
    // The signup-pace site raised once, the deliberate 2 left alone.
    expect(outcomes.reduce((n, o) => n + o.paced, 0)).toBe(1);
    const { data: sites } = await db.from("workspaces").select("id, auto_generate_weekly_limit, trial_resume_key").eq("account_id", s.accountId).order("auto_generate_weekly_limit");
    expect(sites!.map((w) => w.auto_generate_weekly_limit)).toEqual([2, 21]);
    // Each site owed the follow-up once, and it was handed off once.
    expect(outcomes.reduce((n, o) => n + o.owed, 0)).toBe(2);
    expect(sites!.every((w) => w.trial_resume_key === s.subscription)).toBe(true);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveBeenCalledWith({ accountId: s.accountId, key: s.subscription, draftWeek: true });

    // One trial-started email, to the one owner, and one claim for it.
    expect(mailed).toHaveBeenCalledTimes(1);
    const { data: emails } = await db.from("sent_emails").select("email_type, subject_id").eq("account_id", s.accountId);
    expect(emails).toEqual([{ email_type: "trial_started", subject_id: `${s.accountId}:${s.subscription}` }]);

    // The funnel's trial, once per site.
    const { data: steps } = await db.from("system_events").select("workspace_id").eq("account_id", s.accountId).eq("context->>step", "trial_started");
    expect(steps!.map((e) => e.workspace_id).sort()).toEqual([...s.workspaceIds].sort());
  }

  /** How many times the return page said it recorded the checkout before the webhook. */
  async function returnPageRecords(s: Seeded): Promise<number> {
    const { data } = await db.from("system_events").select("id").eq("account_id", s.accountId).eq("source", "billing.checkout");
    return (data ?? []).length;
  }

  it("webhook first, then the return page: the page finds it recorded and writes nothing", async () => {
    const s = await seed("webhook-first");
    reset();
    expect((await deliverWebhook(s)).status).toBe(200);
    await settle();
    const poll = await pollReturn(s);
    expect(poll.body.active).toBe(true);
    await expectRecordedOnce(s);
    // The page never ran an activation of its own.
    expect(outcomes).toHaveLength(1);
    expect(await returnPageRecords(s)).toBe(0);
  });

  it("return page first, then the webhook: the page activates, and the webhook is a no-op", async () => {
    const s = await seed("return-first");
    reset();
    const poll = await pollReturn(s);
    expect(poll).toEqual({ status: 200, body: { status: "complete", active: true } });
    await settle();
    expect(await returnPageRecords(s)).toBe(1);
    expect((await deliverWebhook(s)).status).toBe(200);
    await expectRecordedOnce(s);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({ recorded: false, paced: 0, owed: 0 });
  });

  it("both at once: one write lands, and nothing is written or sent twice", async () => {
    const s = await seed("concurrent");
    reset();
    const [delivered, poll] = await Promise.all([deliverWebhook(s), pollReturn(s)]);
    expect(delivered.status).toBe(200);
    expect(poll.body.active).toBe(true);
    await expectRecordedOnce(s);
    // Stripe redelivers the event later; still nothing new.
    expect((await deliverWebhook(s)).status).toBe(200);
    await expectRecordedOnce(s);
  });

  it("five activations of one checkout at once still write it once", async () => {
    // The doors above interleave however the event loop lets them. This
    // fires the shared write itself five times side by side, so that the
    // conditional updates really do meet inside Postgres.
    const s = await seed("five-at-once");
    reset();
    const subscription = await readCheckoutSubscription(s.subscription);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        activateCheckout(db, { accountId: s.accountId, customerId: subscription.customer as string, subscription, hints: sessions.get(s.session)!.metadata as Stripe.Metadata }),
      ),
    );
    await expectRecordedOnce(s);
  });

  it("follows up a checkout whose ids `customer.subscription.created` wrote first", async () => {
    // Stripe does not order the two events, and the subscription carries our
    // account id, so the ids and the status are often on the account before
    // the checkout arrives. The checkout's account write then matches no row,
    // and the sites must still be raised, owed and handed off, and the email
    // sent: none of that is gated on the account write.
    const s = await seed("subscription-created-first");
    await db
      .from("accounts")
      .update({ stripe_customer_id: "cus_from_created", stripe_subscription_id: s.subscription, plan_status: "trialing", trial_ends_at: TRIAL_END, plan: "growth" })
      .eq("id", s.accountId);
    reset();
    expect((await deliverWebhook(s)).status).toBe(200);
    await settle();
    expect(outcomes).toEqual([expect.objectContaining({ recorded: false, paced: 1, owed: 2 })]);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(mailed).toHaveBeenCalledTimes(1);
  });

  it("does not put a cancelled plan back to trialing when the event arrives late", async () => {
    const s = await seed("late-after-cancel");
    reset();
    expect((await pollReturn(s)).body.active).toBe(true);
    await settle();
    await db.from("accounts").update({ plan_status: "canceled" }).eq("id", s.accountId);
    expect((await deliverWebhook(s)).status).toBe(200);
    const { data } = await db.from("accounts").select("plan_status").eq("id", s.accountId).single();
    expect(data!.plan_status).toBe("canceled");
  });
});
