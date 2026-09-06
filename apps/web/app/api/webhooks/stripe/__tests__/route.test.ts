import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The Stripe webhook, with Stripe and Supabase both faked
// ---------------------------------------------------------------------------
//
// The bug these exist for: `checkout.session.completed` wrote the customer id,
// the subscription id and plan_status and never wrote `plan`. Because
// agencies.plan is `not null default 'starter'`, a EUR 199 Agency buyer stayed
// on Managed's row - badged "Managed plan" and metered at 100 articles instead
// of 400. Every assertion below is about which columns reach the database.

type Row = Record<string, unknown>;

/** Every `.update(row).eq(col, val)` this request made, per table. */
const writes: { table: string; row: Row; col: string; val: unknown }[] = [];
let workspaceRows: Row[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      update: (row: Row) => ({
        eq: (col: string, val: unknown) => {
          writes.push({ table, row, col, val });
          return Promise.resolve({ error: null });
        },
      }),
      select: () => ({ eq: () => Promise.resolve({ data: workspaceRows }) }),
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

/** The one row written to `agencies`. */
function agencyWrite(): { row: Row; col: string; val: unknown } {
  const found = writes.filter((w) => w.table === "agencies");
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
        metadata: { agency_id: "agency-1", plan: "growth", interval: "month" },
        ...overrides,
      },
    },
  };
}

function subscriptionEvent(
  type: "created" | "updated" | "deleted",
  overrides: Record<string, unknown> = {},
) {
  return {
    type: `customer.subscription.${type}`,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        items: { data: [{ price: { id: GROWTH } }] },
        metadata: { agency_id: "agency-1" },
        cancel_at_period_end: false,
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  writes.length = 0;
  workspaceRows = [];
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

    const { row, col, val } = agencyWrite();
    expect(col).toBe("id");
    expect(val).toBe("agency-1");
    // The regression: without this the row stays on 'starter' and the account
    // is metered at 100 articles rather than Agency's 400.
    expect(row.plan).toBe("growth");
    expect(row.plan_status).toBe("active");
    expect(row.stripe_customer_id).toBe("cus_1");
    expect(row.stripe_subscription_id).toBe("sub_1");
  });

  it("writes starter when starter is what was bought", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: STARTER } }] } });
    await deliver(checkoutCompleted({ metadata: { agency_id: "agency-1", plan: "starter" } }));
    expect(agencyWrite().row.plan).toBe("starter");
  });

  it("resolves a yearly price to its tier", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: GROWTH_YEARLY } }] } });
    await deliver(checkoutCompleted({ metadata: { agency_id: "agency-1", plan: "growth" } }));
    expect(agencyWrite().row.plan).toBe("growth");
  });

  it("prefers the subscription's price over the session's metadata hint", async () => {
    // Metadata says Managed, the money says Agency. The money wins.
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: GROWTH } }] } });
    await deliver(checkoutCompleted({ metadata: { agency_id: "agency-1", plan: "starter" } }));
    expect(agencyWrite().row.plan).toBe("growth");
  });

  it("falls back to the metadata hint when the subscription read fails", async () => {
    retrieveSubscription.mockRejectedValue(new Error("stripe down"));
    await deliver(checkoutCompleted());
    expect(agencyWrite().row.plan).toBe("growth");
  });

  it("falls back to the metadata hint when the price id is not one we sell", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: "price_legacy" } }] } });
    await deliver(checkoutCompleted());
    expect(agencyWrite().row.plan).toBe("growth");
  });

  it("leaves plan alone rather than guessing when nothing resolves", async () => {
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: "price_legacy" } }] } });
    await deliver(checkoutCompleted({ metadata: { agency_id: "agency-1" } }));
    const { row } = agencyWrite();
    expect(row).not.toHaveProperty("plan");
    // Still records the purchase, so the later subscription event can find it.
    expect(row.plan_status).toBe("active");
  });

  it("ignores a metadata plan that is not a tier we sell", async () => {
    retrieveSubscription.mockRejectedValue(new Error("stripe down"));
    await deliver(checkoutCompleted({ metadata: { agency_id: "agency-1", plan: "enterprise" } }));
    expect(agencyWrite().row).not.toHaveProperty("plan");
  });

  it("accepts client_reference_id when the session carries no agency metadata", async () => {
    await deliver(
      checkoutCompleted({ metadata: { plan: "growth" }, client_reference_id: "agency-2" }),
    );
    expect(agencyWrite().val).toBe("agency-2");
  });

  it("writes nothing when the session names no agency", async () => {
    await deliver(checkoutCompleted({ metadata: {}, client_reference_id: null }));
    expect(writes).toHaveLength(0);
  });

  it("raises each site to the pace the purchased tier starts at", async () => {
    // The tier decides the target: a site that bought Agency (growth) starts at
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
    const { row } = agencyWrite();
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
    const { row } = agencyWrite();
    expect(row).not.toHaveProperty("plan_status");
    expect(row.plan).toBe("growth");
  });

  it("takes the tier from its own metadata when the price is unknown", async () => {
    await deliver(
      subscriptionEvent("created", {
        items: { data: [{ price: { id: "price_legacy" } }] },
        metadata: { agency_id: "agency-1", plan: "starter" },
      }),
    );
    expect(agencyWrite().row.plan).toBe("starter");
  });
});

describe("customer.subscription.updated / deleted", () => {
  it("still writes tier, status and period end", async () => {
    await deliver(
      subscriptionEvent("updated", { current_period_end: 1_800_000_000, status: "past_due" }),
    );
    const { row } = agencyWrite();
    expect(row.plan).toBe("growth");
    expect(row.plan_status).toBe("past_due");
    expect(row.current_period_end).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(row.cancels_at).toBeNull();
  });

  it("records a scheduled cancellation and clears it on the delete", async () => {
    await deliver(
      subscriptionEvent("updated", { cancel_at_period_end: true, cancel_at: 1_800_000_000 }),
    );
    expect(agencyWrite().row.cancels_at).toBe(new Date(1_800_000_000 * 1000).toISOString());

    writes.length = 0;
    await deliver(subscriptionEvent("deleted"));
    const { row } = agencyWrite();
    expect(row.plan_status).toBe("canceled");
    expect(row.cancels_at).toBeNull();
  });

  it("matches on the stored subscription id when metadata has no agency", async () => {
    await deliver(subscriptionEvent("updated", { metadata: {} }));
    const { col, val } = agencyWrite();
    expect(col).toBe("stripe_subscription_id");
    expect(val).toBe("sub_1");
  });

  it("does not write the ids on an update, only on a create", async () => {
    await deliver(subscriptionEvent("updated"));
    expect(agencyWrite().row).not.toHaveProperty("stripe_customer_id");
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
    const res = await deliver({ type: "invoice.paid", data: { object: {} } });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
  });
});
