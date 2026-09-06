import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The billing emails, end to end from a Stripe event
// ---------------------------------------------------------------------------
//
// Everything below the webhook is real: recipient resolution, the opt-out
// check, the `sent_emails` claim, the renderer and the layout. Only Stripe,
// the database and Resend's HTTP call are faked, so what these assert is the
// actual message a customer would receive - who it goes to, what the subject
// says, and which links are in the body.
//
// `RESEND_API_KEY` is never set here and `sendTransactionalEmail` is mocked, so
// nothing can reach the real API even if the mock were removed.

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("@/lib/email/resend", () => ({ sendTransactionalEmail }));

type Row = Record<string, unknown>;

let agencyRow: Row | null = null;
let members: { user_id: string; role: string }[] = [];
let emails: Record<string, string> = {};
/** (email_type, subject_id, recipient) already claimed - the real primary key. */
const claimed = new Set<string>();
const agencyUpdates: Row[] = [];

function selectBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b as never;
  Object.assign(b, {
    eq: chain,
    in: chain,
    not: chain,
    select: chain,
    single: () => resolved(table, true),
    maybeSingle: () => resolved(table, true),
    then: (resolve: (v: unknown) => unknown) => resolve(rows(table)),
  });
  return b as never;
}

function resolved(table: string, single: boolean) {
  return {
    then: (resolve: (v: unknown) => unknown) =>
      resolve(single ? { data: table === "agencies" ? agencyRow : null, error: null } : rows(table)),
  } as never;
}

function rows(table: string) {
  if (table === "agency_members") return { data: members, error: null };
  return { data: [], error: null };
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => selectBuilder(table),
      update: (row: Row) => {
        if (table === "agencies") agencyUpdates.push(row);
        return selectBuilder(table);
      },
      insert: async (row: Row) => {
        if (table !== "sent_emails") return { error: null };
        const key = `${row.email_type}|${row.subject_id}|${row.recipient}`;
        if (claimed.has(key)) return { error: { code: "23505", message: "duplicate key" } };
        claimed.add(key);
        return { error: null };
      },
      delete: () => {
        const chain = { eq: () => chain, then: (r: (v: unknown) => unknown) => r({ error: null }) };
        return chain;
      },
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: emails[id] } } }),
      },
    },
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
    getStripe: () => ({ webhooks: { constructEvent }, subscriptions: { retrieve: retrieveSubscription } }),
  };
});

const STARTER = "price_starter_month";
const GROWTH = "price_growth_month";

async function deliver(event: unknown) {
  constructEvent.mockReturnValue(event);
  const { POST } = await import("../route");
  return POST(
    new Request("https://app.altorank.co/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "sig" },
      body: "{}",
    }),
  );
}

/** Every send as (to, subject, html). */
function sends(): { to: string; subject: string; html: string; footer: string }[] {
  return sendTransactionalEmail.mock.calls.map((c) => ({
    to: c[0],
    subject: c[1],
    html: c[2],
    footer: c[3],
  }));
}

function subscriptionEvent(overrides: Row = {}, created = 1_790_000_000) {
  return {
    type: "customer.subscription.updated",
    created,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        items: { data: [{ price: { id: GROWTH } }] },
        metadata: { agency_id: "agency-1" },
        cancel_at_period_end: false,
        pause_collection: null,
        ...overrides,
      },
    },
  };
}

function invoiceFailed(overrides: Row = {}) {
  return {
    type: "invoice.payment_failed",
    created: 1_790_000_000,
    data: {
      object: {
        id: "in_1",
        customer: "cus_1",
        created: Date.parse("2026-09-01T10:00:00Z") / 1000,
        amount_due: 6900,
        currency: "eur",
        parent: { subscription_details: { subscription: "sub_1", metadata: { agency_id: "agency-1" } } },
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  claimed.clear();
  agencyUpdates.length = 0;
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
  constructEvent.mockReset();
  retrieveSubscription.mockReset();
  retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: GROWTH } }] } });
  members = [
    { user_id: "u-owner", role: "owner" },
    { user_id: "u-admin", role: "admin" },
    { user_id: "u-editor", role: "editor" },
  ];
  emails = { "u-owner": "owner@acme.co", "u-admin": "admin@acme.co", "u-editor": "editor@acme.co" };
  agencyRow = null;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_PRICE_STARTER = STARTER;
  process.env.STRIPE_PRICE_GROWTH = GROWTH;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
  delete process.env.RESEND_API_KEY;
});

describe("invoice.payment_failed → the dunning email", () => {
  it("goes to the owner and admin, never to an editor", async () => {
    agencyRow = {
      id: "agency-1",
      plan_status: "active",
      payment_failed_at: null,
      plan: "starter",
      name: "Acme Agency",
    };
    await deliver(invoiceFailed());

    expect(sends().map((s) => s.to).sort()).toEqual(["admin@acme.co", "owner@acme.co"]);
    expect(sends().some((s) => s.to === "editor@acme.co")).toBe(false);
  });

  /**
   * The email and the in-app banner both count seven days from
   * `payment_failed_at`. A customer who reads one date on screen and another in
   * their inbox has been told two things by one company.
   */
  it("names the same grace date the banner shows, and the amount Stripe charged", async () => {
    agencyRow = { id: "agency-1", plan_status: "active", payment_failed_at: null, plan: "starter", name: "Acme" };
    await deliver(invoiceFailed());

    const [first] = sends();
    expect(first.subject).toBe("Your card was declined — Managed stays on until September 8");
    expect(first.html).toContain("September 8");
    expect(first.html).toContain("€69.00");
    expect(first.html).toContain("https://app.altorank.co/settings/billing");
    expect(first.html).toContain("<strong>Nothing has stopped.</strong>");
  });

  /**
   * Stripe raises a fresh `payment_failed` on every card retry, for days, and
   * redelivers each of those until it gets a 200. One episode, one email.
   */
  it("sends once per episode however many retries arrive", async () => {
    agencyRow = { id: "agency-1", plan_status: "active", payment_failed_at: null, plan: "starter", name: "Acme" };
    await deliver(invoiceFailed());
    expect(sends()).toHaveLength(2);

    // The row now carries the timestamp the first failure wrote.
    agencyRow = {
      ...agencyRow,
      plan_status: "past_due",
      payment_failed_at: new Date(Date.parse("2026-09-01T10:00:00Z")).toISOString(),
    };
    await deliver(invoiceFailed({ id: "in_2", created: Date.parse("2026-09-03T10:00:00Z") / 1000 }));
    await deliver(invoiceFailed({ id: "in_3", created: Date.parse("2026-09-05T10:00:00Z") / 1000 }));
    expect(sends()).toHaveLength(2);
  });

  it("says nothing when the invoice matches no agency", async () => {
    agencyRow = null;
    await deliver(invoiceFailed());
    expect(sends()).toHaveLength(0);
  });

  /** An email problem must not make Stripe redeliver a processed event. */
  it("still returns 200 when the send is refused", async () => {
    agencyRow = { id: "agency-1", plan_status: "active", payment_failed_at: null, plan: "starter", name: "Acme" };
    sendTransactionalEmail.mockRejectedValue(new Error("Resend refused the email"));
    const res = await deliver(invoiceFailed());
    expect(res.status).toBe(200);
    expect(agencyUpdates.some((u) => "payment_failed_at" in u)).toBe(true);
  });
});

describe("customer.subscription.updated → the plan-change email", () => {
  it("says which way the plan moved and what is now included", async () => {
    agencyRow = { id: "agency-1", plan_status: "active", payment_failed_at: null, plan: "starter", name: "Acme" };
    await deliver(subscriptionEvent());

    const [first] = sends();
    expect(first.subject).toBe("Your plan is now Agency");
    expect(first.html).toContain("400 articles a month");
    expect(first.html).toContain("charged the difference");
  });

  it("says nothing when the tier did not change", async () => {
    agencyRow = { id: "agency-1", plan_status: "active", payment_failed_at: null, plan: "growth", name: "Acme" };
    await deliver(subscriptionEvent());
    expect(sends()).toHaveLength(0);
  });

  it("calls a move down a downgrade, with the credit explained", async () => {
    agencyRow = { id: "agency-1", plan_status: "active", payment_failed_at: null, plan: "growth", name: "Acme" };
    retrieveSubscription.mockResolvedValue({ items: { data: [{ price: { id: STARTER } }] } });
    await deliver(subscriptionEvent({ items: { data: [{ price: { id: STARTER } }] } }));

    expect(sends()[0].subject).toBe("Your plan is now Managed");
    expect(sends()[0].html).toContain("credited the unused part");
  });
});

describe("customer.subscription.updated → the cancellation email", () => {
  const cancelAt = Date.parse("2026-12-01T00:00:00Z") / 1000;

  it("names the date the plan ends and offers the undo", async () => {
    agencyRow = {
      id: "agency-1",
      plan_status: "active",
      payment_failed_at: null,
      plan: "growth",
      name: "Acme",
      cancels_at: null,
    };
    await deliver(subscriptionEvent({ cancel_at_period_end: true, cancel_at: cancelAt }));

    const [first] = sends();
    expect(first.subject).toBe("Your plan ends on December 1, 2026");
    expect(first.html).toContain("Keep the plan instead");
    expect(first.html).toContain("stays readable and exportable");
  });

  /** Several `updated` events follow one cancellation; the customer gets one. */
  it("does not repeat for an unchanged cancellation date", async () => {
    agencyRow = {
      id: "agency-1",
      plan_status: "active",
      payment_failed_at: null,
      plan: "growth",
      name: "Acme",
      cancels_at: new Date(cancelAt * 1000).toISOString(),
    };
    await deliver(subscriptionEvent({ cancel_at_period_end: true, cancel_at: cancelAt }));
    expect(sends()).toHaveLength(0);
  });

  it("says nothing when the plan simply renewed", async () => {
    agencyRow = {
      id: "agency-1",
      plan_status: "active",
      payment_failed_at: null,
      plan: "growth",
      name: "Acme",
      cancels_at: null,
    };
    await deliver(subscriptionEvent());
    expect(sends()).toHaveLength(0);
  });
});
