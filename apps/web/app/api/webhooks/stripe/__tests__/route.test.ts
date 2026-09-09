import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The Stripe webhook, with Stripe and Supabase both faked
// ---------------------------------------------------------------------------
//
// The bug these exist for: `checkout.session.completed` wrote the customer id,
// the subscription id and plan_status and never wrote `plan`. Because
// accounts.plan is `not null default 'starter'`, a EUR 199 Agency buyer stayed
// on Managed's row - badged "Managed plan" and metered at 100 articles instead
// of 400. Every assertion below is about which columns reach the database.

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

/** Every `.update(row).eq(col, val)` this request made, per table. */
const writes: { table: string; row: Row; col: string; val: unknown; filters: Filter[] }[] = [];
let workspaceRows: Row[] = [];
/** The one account row any single-row read of `accounts` returns; null = no match. */
let accountRow: Row | null = null;

/**
 * A chainable fake of the PostgREST builder: filters are recorded, the
 * terminal `await` resolves. Reads of `accounts` with `.single()` /
 * `.maybeSingle()` return `accountRow`; reads of `workspaces` return
 * `workspaceRows`; updates are recorded and, when `.select()`ed, report
 * `workspaceRows` back as the touched rows.
 */
function query(table: string, op: "select" | "update", row?: Row) {
  const filters: Filter[] = [];
  let single = false;
  const q = {
    eq: (c: string, v: unknown) => (filters.push([c, "eq", v]), q),
    not: (c: string, o: string, v: unknown) => (filters.push([c, `not ${o}`, v]), q),
    select: () => q,
    single: () => ((single = true), q),
    maybeSingle: () => ((single = true), q),
    then: (resolve: (v: unknown) => unknown) => {
      if (op === "update") {
        writes.push({ table, row: row!, col: filters[0]?.[0], val: filters[0]?.[2], filters });
        return resolve({ data: workspaceRows, error: null });
      }
      if (table === "accounts") return resolve({ data: single ? accountRow : accountRow ? [accountRow] : [] });
      return resolve({ data: workspaceRows });
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      update: (row: Row) => query(table, "update", row),
      select: () => query(table, "select"),
    }),
  }),
}));

const { constructEvent, retrieveSubscription } = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrieveSubscription: vi.fn(),
}));

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripe: () => ({
      webhooks: { constructEvent },
      subscriptions: { retrieve: retrieveSubscription },
    }),
  };
});

const STARTER = "price_starter_month";
const GROWTH = "price_growth_month";
const GROWTH_YEARLY = "price_growth_year";

function post() {
  return new Request("https://app.altorank.co/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  });
}

async function deliver(event: unknown) {
  constructEvent.mockReturnValue(event);
  const { POST } = await import("../route");
  return POST(post());
}

/** The one row written to `accounts`. */
function accountWrite(): { row: Row; col: string; val: unknown } {
  const found = writes.filter((w) => w.table === "accounts");
  expect(found).toHaveLength(1);
  return found[0];
}

function checkoutCompleted(overrides: Record<string, unknown> = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { account_id: "account-1", plan: "growth", interval: "month" },
        ...overrides,
      },
    },
  };
}

function subscriptionEvent(
  type: "created" | "updated" | "deleted",
  overrides: Record<string, unknown> = {},
  previousAttributes?: Record<string, unknown>,
) {
  return {
    type: `customer.subscription.${type}`,
    created: 1_790_000_000,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        items: { data: [{ price: { id: GROWTH } }] },
        metadata: { account_id: "account-1" },
        cancel_at_period_end: false,
        pause_collection: null,
        ...overrides,
      },
      ...(previousAttributes ? { previous_attributes: previousAttributes } : {}),
    },
  };
}

function invoiceEvent(type: "payment_failed" | "paid", overrides: Record<string, unknown> = {}) {
  return {
    type: `invoice.${type}`,
    created: 1_790_000_000,
    data: {
      object: {
        id: "in_1",
        customer: "cus_1",
        created: 1_789_000_000,
        parent: { subscription_details: { subscription: "sub_1", metadata: { account_id: "account-1" } } },
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  writes.length = 0;
  workspaceRows = [];
  accountRow = null;
  constructEvent.mockReset();
  retrieveSubscription.mockReset();
  retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: GROWTH } }] } });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_PRICE_STARTER = STARTER;
  process.env.STRIPE_PRICE_STARTER_YEARLY = "price_starter_year";
  process.env.STRIPE_PRICE_GROWTH = GROWTH;
  process.env.STRIPE_PRICE_GROWTH_YEARLY = GROWTH_YEARLY;
});

describe("checkout.session.completed", () => {
  it("writes the tier the subscription's price sells, not the column default", async () => {
    const res = await deliver(checkoutCompleted());
    expect(res.status).toBe(200);

    const { row, col, val } = accountWrite();
    expect(col).toBe("id");
    expect(val).toBe("account-1");
    // The regression: without this the row stays on 'starter' and the account
    // is metered at 100 articles rather than Agency's 400.
    expect(row.plan).toBe("growth");
    expect(row.plan_status).toBe("active");
    expect(row.stripe_customer_id).toBe("cus_1");
    expect(row.stripe_subscription_id).toBe("sub_1");
  });

  it("writes starter when starter is what was bought", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: STARTER } }] } });
    await deliver(checkoutCompleted({ metadata: { account_id: "account-1", plan: "starter" } }));
    expect(accountWrite().row.plan).toBe("starter");
  });

  it("resolves a yearly price to its tier", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: GROWTH_YEARLY } }] } });
    await deliver(checkoutCompleted({ metadata: { account_id: "account-1", plan: "growth" } }));
    expect(accountWrite().row.plan).toBe("growth");
  });

  it("prefers the subscription's price over the session's metadata hint", async () => {
    // Metadata says Managed, the money says Agency. The money wins.
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: GROWTH } }] } });
    await deliver(checkoutCompleted({ metadata: { account_id: "account-1", plan: "starter" } }));
    expect(accountWrite().row.plan).toBe("growth");
  });

  it("falls back to the metadata hint when the subscription read fails", async () => {
    retrieveSubscription.mockRejectedValue(new Error("stripe down"));
    await deliver(checkoutCompleted());
    expect(accountWrite().row.plan).toBe("growth");
  });

  it("falls back to the metadata hint when the price id is not one we sell", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: "price_legacy" } }] } });
    await deliver(checkoutCompleted());
    expect(accountWrite().row.plan).toBe("growth");
  });

  it("leaves plan alone rather than guessing when nothing resolves", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: "price_legacy" } }] } });
    await deliver(checkoutCompleted({ metadata: { account_id: "account-1" } }));
    const { row } = accountWrite();
    expect(row).not.toHaveProperty("plan");
    // Still records the purchase, so the later subscription event can find it.
    expect(row.plan_status).toBe("active");
  });

  it("ignores a metadata plan that is not a tier we sell", async () => {
    retrieveSubscription.mockRejectedValue(new Error("stripe down"));
    await deliver(checkoutCompleted({ metadata: { account_id: "account-1", plan: "enterprise" } }));
    expect(accountWrite().row).not.toHaveProperty("plan");
  });

  it("accepts client_reference_id when the session carries no account metadata", async () => {
    await deliver(
      checkoutCompleted({ metadata: { plan: "growth" }, client_reference_id: "account-2" }),
    );
    expect(accountWrite().val).toBe("account-2");
  });

  it("writes nothing when the session names no account", async () => {
    await deliver(checkoutCompleted({ metadata: {}, client_reference_id: null }));
    expect(writes).toHaveLength(0);
  });

  it("raises each site to the pace the purchased tier starts at", async () => {
    // The tier decides the target: a site that bought Account (growth) starts at
    // 21 a week. Before PLAN_DEFAULT_PACE every tier started at 7, so a customer
    // paying for 400 articles a month defaulted to about 30.
    workspaceRows = [
      // Never set, and sitting on the signup pace: both are the product's own
      // value, so both are raised.
      { id: "ws-1", auto_generate_weekly_limit: null },
      { id: "ws-4", auto_generate_weekly_limit: 7 },
      // Deliberately paused, a deliberate 2, and one already past the tier's
      // default: every one is somebody's choice, so left alone.
      { id: "ws-2", auto_generate_weekly_limit: 0 },
      { id: "ws-3", auto_generate_weekly_limit: 2 },
      { id: "ws-5", auto_generate_weekly_limit: 25 },
    ];
    await deliver(checkoutCompleted());
    const paced = writes.filter((w) => w.table === "workspaces");
    expect(paced.map((w) => w.val).sort()).toEqual(["ws-1", "ws-4"]);
    for (const w of paced) expect(w.row).toEqual({ auto_generate_weekly_limit: 21 });
  });
});

describe("customer.subscription.created", () => {
  it("is handled at all: it used to fall through the switch", async () => {
    await deliver(subscriptionEvent("created"));
    const { row } = accountWrite();
    expect(row.plan).toBe("growth");
    expect(row.plan_status).toBe("active");
    expect(row.stripe_customer_id).toBe("cus_1");
    expect(row.stripe_subscription_id).toBe("sub_1");
  });

  it("does not write a not-yet-paid status, which could arrive after checkout", async () => {
    // 3-D Secure creates the subscription `incomplete`; Stripe does not order
    // this against checkout.session.completed, so writing past_due here could
    // knock a live account backwards.
    await deliver(subscriptionEvent("created", { status: "incomplete" }));
    const { row } = accountWrite();
    expect(row).not.toHaveProperty("plan_status");
    expect(row.plan).toBe("growth");
  });

  it("takes the tier from its own metadata when the price is unknown", async () => {
    await deliver(
      subscriptionEvent("created", {
        items: { data: [{ price: { id: "price_legacy" } }] },
        metadata: { account_id: "account-1", plan: "starter" },
      }),
    );
    expect(accountWrite().row.plan).toBe("starter");
  });
});

describe("customer.subscription.updated / deleted", () => {
  it("still writes tier, status and period end", async () => {
    await deliver(
      subscriptionEvent("updated", { current_period_end: 1_800_000_000, status: "past_due" }),
    );
    const { row } = accountWrite();
    expect(row.plan).toBe("growth");
    expect(row.plan_status).toBe("past_due");
    expect(row.current_period_end).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(row.cancels_at).toBeNull();
  });

  it("records a scheduled cancellation and clears it on the delete", async () => {
    await deliver(
      subscriptionEvent("updated", { cancel_at_period_end: true, cancel_at: 1_800_000_000 }),
    );
    expect(accountWrite().row.cancels_at).toBe(new Date(1_800_000_000 * 1000).toISOString());

    writes.length = 0;
    await deliver(subscriptionEvent("deleted"));
    const { row } = accountWrite();
    expect(row.plan_status).toBe("canceled");
    expect(row.cancels_at).toBeNull();
  });

  it("matches on the stored subscription id when metadata has no account", async () => {
    await deliver(subscriptionEvent("updated", { metadata: {} }));
    const { col, val } = accountWrite();
    expect(col).toBe("stripe_subscription_id");
    expect(val).toBe("sub_1");
  });

  it("still resolves a subscription whose metadata carries the pre-085 key", async () => {
    // Stripe metadata is a snapshot taken at purchase. Every subscription
    // created before `agencies` became `accounts` (085, 2026-09-09) says
    // `agency_id`, and Stripe never rewrites it; the webhook must read both
    // keys for as long as one of those subscriptions is alive.
    await deliver(subscriptionEvent("updated", { metadata: { agency_id: "account-1" } }));
    const { col, val } = accountWrite();
    expect(col).toBe("id");
    expect(val).toBe("account-1");
  });

  it("does not write the ids on an update, only on a create", async () => {
    await deliver(subscriptionEvent("updated"));
    expect(accountWrite().row).not.toHaveProperty("stripe_customer_id");
  });

  it("follows the price after a plan switch, even when the metadata hint is stale", async () => {
    // `switchPlan` changes the price on the existing item; the `plan` hint in
    // metadata was written at the first purchase. The money says Agency.
    await deliver(
      subscriptionEvent("updated", {
        items: { data: [{ price: { id: GROWTH_YEARLY } }] },
        metadata: { account_id: "account-1", plan: "starter" },
      }),
    );
    expect(accountWrite().row.plan).toBe("growth");
  });

  it("falls back to the hint only when the price is not one we sell", async () => {
    await deliver(
      subscriptionEvent("updated", {
        items: { data: [{ price: { id: "price_legacy" } }] },
        metadata: { account_id: "account-1", plan: "starter" },
      }),
    );
    expect(accountWrite().row.plan).toBe("starter");
  });

  it("clears the failed-payment mark when the subscription is active again", async () => {
    await deliver(subscriptionEvent("updated"));
    expect(accountWrite().row.payment_failed_at).toBeNull();
  });

  it("starts the grace window when the subscription goes past due without an invoice event", async () => {
    accountRow = { id: "account-1", plan_status: "active", payment_failed_at: null };
    await deliver(subscriptionEvent("updated", { status: "past_due" }));
    const rows = writes.filter((w) => w.table === "accounts");
    expect(rows).toHaveLength(2);
    expect(rows[0].row.plan_status).toBe("past_due");
    expect(rows[0].row).not.toHaveProperty("payment_failed_at");
    expect(rows[1].row).toEqual({ payment_failed_at: new Date(1_790_000_000 * 1000).toISOString() });
  });

  it("keeps the first failure's timestamp on a later past_due update", async () => {
    accountRow = { id: "account-1", plan_status: "past_due", payment_failed_at: "2026-09-01T00:00:00.000Z" };
    await deliver(subscriptionEvent("updated", { status: "past_due" }));
    expect(writes.filter((w) => w.table === "accounts")).toHaveLength(1);
  });

  it("does not report a paused subscription as a failed payment", async () => {
    // Stripe pauses a subscription when a trial ends with no card, or from
    // the dashboard. Mapped to past_due with no payment_failed_at, dunning
    // read it as "lapsed" and the account saw "Payment failed" for a card
    // that never failed (PM-C-P2-1).
    accountRow = { id: "account-1", plan_status: "active", payment_failed_at: null };
    await deliver(subscriptionEvent("updated", { status: "paused" }));
    const rows = writes.filter((w) => w.table === "accounts");
    expect(rows).toHaveLength(1);
    expect(rows[0].row.plan_status).toBe("inactive");
    expect(rows[0].row).not.toHaveProperty("payment_failed_at");
  });
});

describe("the account pause ending on Stripe's side", () => {
  it("resumes the billing-paused workspaces when pause_collection is lifted", async () => {
    // Stripe's `resumes_at` clears the pause on the date and reports the old
    // value in previous_attributes. Our rows have to follow, or the customer
    // is billed for a month in which nothing is drafted.
    await deliver(
      subscriptionEvent("updated", { pause_collection: null }, { pause_collection: { behavior: "void" } }),
    );
    const resumed = writes.filter((w) => w.table === "workspaces");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].row).toEqual({ status: "on", paused_until: null });
    expect(resumed[0].filters).toEqual([
      ["account_id", "eq", "account-1"],
      ["status", "eq", "paused"],
      ["paused_until", "not is", null],
    ]);
  });

  it("finds the account by subscription id when the metadata has none", async () => {
    accountRow = { id: "account-9" };
    await deliver(
      subscriptionEvent("updated", { metadata: {}, pause_collection: null }, { pause_collection: { behavior: "void" } }),
    );
    const resumed = writes.filter((w) => w.table === "workspaces");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].filters[0]).toEqual(["account_id", "eq", "account-9"]);
  });

  it("leaves a pause alone on an ordinary update that merely carries pause_collection: null", async () => {
    // Every update to an unpaused subscription says pause_collection: null.
    // Acting on that would resume a pause written a moment ago, before
    // Stripe's own event for it arrives.
    await deliver(subscriptionEvent("updated", { pause_collection: null }, { cancel_at_period_end: true }));
    expect(writes.filter((w) => w.table === "workspaces")).toHaveLength(0);
  });

  it("does nothing while the pause is still on", async () => {
    await deliver(
      subscriptionEvent(
        "updated",
        { pause_collection: { behavior: "void", resumes_at: 1_800_000_000 } },
        { pause_collection: null },
      ),
    );
    expect(writes.filter((w) => w.table === "workspaces")).toHaveLength(0);
  });
});

describe("invoice.payment_failed", () => {
  it("marks the plan past due from the failed invoice's time", async () => {
    accountRow = { id: "account-1", plan_status: "active", payment_failed_at: null };
    await deliver(invoiceEvent("payment_failed"));
    const { row, col, val } = accountWrite();
    expect(col).toBe("id");
    expect(val).toBe("account-1");
    expect(row).toEqual({
      plan_status: "past_due",
      payment_failed_at: new Date(1_789_000_000 * 1000).toISOString(),
    });
  });

  it("is idempotent: a retry of the same run keeps the first failure's timestamp", async () => {
    accountRow = { id: "account-1", plan_status: "past_due", payment_failed_at: "2026-09-01T00:00:00.000Z" };
    await deliver(invoiceEvent("payment_failed"));
    expect(writes).toHaveLength(0);
  });

  it("does not turn an account that never paid into a past-due one", async () => {
    // A first checkout whose card bounced: `checkout.session.completed`
    // never fired, the row is inactive, and it stays so.
    accountRow = { id: "account-1", plan_status: "inactive", payment_failed_at: null };
    await deliver(invoiceEvent("payment_failed"));
    const { row } = accountWrite();
    expect(row).not.toHaveProperty("plan_status");
    expect(row).toHaveProperty("payment_failed_at");
  });

  it("matches by customer when the invoice names no subscription", async () => {
    accountRow = { id: "account-1", plan_status: "active", payment_failed_at: null };
    await deliver(invoiceEvent("payment_failed", { parent: null }));
    expect(accountWrite().row.plan_status).toBe("past_due");
  });

  it("writes nothing for an invoice no account owns", async () => {
    accountRow = null;
    await deliver(invoiceEvent("payment_failed"));
    expect(writes).toHaveLength(0);
  });
});

describe("invoice.paid", () => {
  it("reinstates a past-due plan and clears the mark", async () => {
    accountRow = { id: "account-1", plan_status: "past_due", payment_failed_at: "2026-09-01T00:00:00.000Z" };
    await deliver(invoiceEvent("paid"));
    expect(accountWrite().row).toEqual({ payment_failed_at: null, plan_status: "active" });
  });

  it("only clears the mark on an already-active plan, and is safe to replay", async () => {
    accountRow = { id: "account-1", plan_status: "active", payment_failed_at: null };
    await deliver(invoiceEvent("paid"));
    expect(accountWrite().row).toEqual({ payment_failed_at: null });
    writes.length = 0;
    await deliver(invoiceEvent("paid"));
    expect(accountWrite().row).toEqual({ payment_failed_at: null });
  });

  it("leaves a first purchase to checkout.session.completed", async () => {
    accountRow = { id: "account-1", plan_status: "inactive", payment_failed_at: null };
    await deliver(invoiceEvent("paid"));
    expect(accountWrite().row).not.toHaveProperty("plan_status");
  });
});

describe("request handling", () => {
  it("rejects an unsigned request without touching the database", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      new Request("https://app.altorank.co/api/webhooks/stripe", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("rejects a bad signature", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("no");
    });
    const { POST } = await import("../route");
    const res = await POST(post());
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("acknowledges an event type it does not handle", async () => {
    const res = await deliver({ type: "charge.refunded", data: { object: {} } });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
  });
});

describe("the seven-day card trial", () => {
  const TRIAL_END = 1_790_604_800; // seven days after the fixture's event time

  it("records a checkout that opened a trial as trialing, with its end", async () => {
    retrieveSubscription.mockResolvedValue({
      status: "trialing",
      trial_end: TRIAL_END,
      items: { data: [{ price: { id: STARTER } }] },
    });
    await deliver(checkoutCompleted({ metadata: { agency_id: "agency-1", plan: "starter" } }));
    expect(agencyWrite().row).toMatchObject({
      plan_status: "trialing",
      plan: "starter",
      trial_ends_at: new Date(TRIAL_END * 1000).toISOString(),
    });
  });

  it("records a checkout with no trial as active, with no trial end", async () => {
    await deliver(checkoutCompleted());
    const { row } = agencyWrite();
    expect(row.plan_status).toBe("active");
    expect(row).not.toHaveProperty("trial_ends_at");
  });

  it("stamps the trial end from a subscription event too", async () => {
    agencyRow = { id: "agency-1", plan_status: "inactive", payment_failed_at: null };
    await deliver(subscriptionEvent("created", { status: "trialing", trial_end: TRIAL_END }));
    expect(agencyWrite().row).toMatchObject({
      plan_status: "trialing",
      trial_ends_at: new Date(TRIAL_END * 1000).toISOString(),
    });
  });

  it("never clears the trial end once the trial converts", async () => {
    agencyRow = { id: "agency-1", plan_status: "trialing", payment_failed_at: null };
    await deliver(subscriptionEvent("updated", { status: "active" }));
    const { row } = agencyWrite();
    expect(row.plan_status).toBe("active");
    expect(row).not.toHaveProperty("trial_ends_at");
  });
});
