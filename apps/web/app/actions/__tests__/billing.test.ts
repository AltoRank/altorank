import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// createCheckoutSession: change the subscription, or start one?
// ---------------------------------------------------------------------------
//
// "Switch to Agency" on a paying account opened a fresh Checkout in
// `mode: "subscription"`. Stripe created a second subscription, the webhook's
// `customer.subscription.created` overwrote `stripe_subscription_id`, and the
// first subscription kept billing with nothing pointing at it.

type Row = Record<string, unknown>;

let agencyRow: Row = {};
const writes: { table: string; row: Row; col: string; val: unknown }[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ single: () => Promise.resolve({ data: agencyRow }) }),
      }),
      update: (row: Row) => ({
        eq: (col: string, val: unknown) => {
          writes.push({ table, row, col, val });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));

const { requireAuth, checkoutCreate, subRetrieve, subUpdate, portalCreate } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ agencyId: "agency-1", role: "owner", user: { id: "u1" } })),
  checkoutCreate: vi.fn(),
  subRetrieve: vi.fn(),
  subUpdate: vi.fn(),
  portalCreate: vi.fn(),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripe: () => ({
      checkout: { sessions: { create: checkoutCreate } },
      subscriptions: { retrieve: subRetrieve, update: subUpdate },
      billingPortal: { sessions: { create: portalCreate } },
    }),
  };
});

const STARTER = "price_starter_month";
const GROWTH = "price_growth_month";

async function choose(plan: "starter" | "growth", interval: "month" | "year" = "month") {
  const { createCheckoutSession } = await import("../billing");
  return createCheckoutSession(plan, interval);
}

beforeEach(() => {
  writes.length = 0;
  agencyRow = { stripe_customer_id: "cus_1", stripe_subscription_id: null, plan_status: "inactive" };
  checkoutCreate.mockReset();
  checkoutCreate.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_1" });
  subRetrieve.mockReset();
  subRetrieve.mockResolvedValue({ items: { data: [{ id: "si_1", price: { id: STARTER } }] } });
  subUpdate.mockReset();
  subUpdate.mockResolvedValue({});
  portalCreate.mockReset();
  portalCreate.mockResolvedValue({ url: "https://billing.stripe.com/p/session_1" });
  process.env.STRIPE_PRICE_STARTER = STARTER;
  process.env.STRIPE_PRICE_GROWTH = GROWTH;
  process.env.STRIPE_PRICE_GROWTH_YEARLY = "price_growth_year";
});

describe("first purchase", () => {
  it("opens Checkout when the account has no subscription", async () => {
    // A result, not a bare string: these actions return `{ ok }` so a Stripe
    // refusal can reach the person as a sentence instead of a Next.js digest.
    const result = await choose("growth");
    expect(result).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(checkoutCreate).toHaveBeenCalledOnce();
    expect(checkoutCreate.mock.calls[0][0]).toMatchObject({
      mode: "subscription",
      line_items: [{ price: GROWTH, quantity: 1 }],
      customer: "cus_1",
    });
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it("opens Checkout again when the stored subscription is canceled", async () => {
    // The id is stale: Stripe will not bill it again, so there is nothing to
    // update and a new subscription is the right thing.
    agencyRow = { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_old", plan_status: "canceled" };
    await choose("starter");
    expect(checkoutCreate).toHaveBeenCalledOnce();
    expect(subUpdate).not.toHaveBeenCalled();
  });
});

describe("plan switch on a live subscription", () => {
  beforeEach(() => {
    agencyRow = { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: "active" };
  });

  it("updates the existing item to the new price, prorated, and never opens Checkout", async () => {
    const result = await choose("growth");

    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(subRetrieve).toHaveBeenCalledWith("sub_1");
    expect(subUpdate).toHaveBeenCalledOnce();
    expect(subUpdate).toHaveBeenCalledWith("sub_1", {
      // `id` names the item being replaced; without it Stripe adds a second
      // item and bills both.
      items: [{ id: "si_1", price: GROWTH }],
      proration_behavior: "create_prorations",
      metadata: { agency_id: "agency-1", plan: "growth", interval: "month" },
    });
    expect(result).toEqual({
      ok: true,
      url: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100"}/settings/billing?status=switched`,
    });
  });

  it("writes the new tier to the row at once, ahead of the webhook", async () => {
    await choose("growth");
    expect(writes).toEqual([{ table: "agencies", row: { plan: "growth" }, col: "id", val: "agency-1" }]);
  });

  it("switches the interval on the same subscription too", async () => {
    await choose("growth", "year");
    expect(subUpdate.mock.calls[0][1].items).toEqual([{ id: "si_1", price: "price_growth_year" }]);
  });

  it("switches in place while a renewal is failing, rather than starting a second subscription", async () => {
    agencyRow = { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: "past_due" };
    await choose("growth");
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(subUpdate).toHaveBeenCalledOnce();
  });

  it("does nothing when the subscription is already on that price", async () => {
    subRetrieve.mockResolvedValue({ items: { data: [{ id: "si_1", price: { id: GROWTH } }] } });
    await choose("growth");
    expect(subUpdate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("refuses anyone but the owner, like every other billing change", async () => {
    requireAuth.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(choose("growth")).rejects.toThrow("Forbidden");
    expect(subUpdate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// When Stripe refuses
// ---------------------------------------------------------------------------
//
// These actions used to throw, and Next.js replaces a thrown server-action
// message with an opaque digest in production - so the two buttons that take
// money were the ones with no way to say why they had not. They return a
// result instead; the client sets `window.location` on `ok` and shows `error`
// otherwise.
//
// The message is ours rather than Stripe's on purpose. Driving the local stack
// against an invalid key surfaced "Invalid API Key provided:
// sk_test_********ess2" into the UI - a sentence naming our own configuration
// that no customer can act on. What they can act on is: nothing was charged.

describe("a Stripe refusal reaches the person who pressed the button", () => {
  it("says nothing was charged when Checkout cannot be opened", async () => {
    checkoutCreate.mockRejectedValueOnce(new Error("Invalid API Key provided: sk_test_********ess2"));
    const result = await choose("growth");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("Checkout could not be opened");
    expect(result.error).toContain("Nothing has been charged");
    // Never Stripe's own words, and never our key.
    expect(result.error).not.toContain("sk_test");
    expect(result.error).not.toContain("Invalid API Key");
  });

  it("says so when the plan switch is refused, and does not move the tier", async () => {
    agencyRow = { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", plan_status: "active" };
    subUpdate.mockRejectedValueOnce(new Error("card_declined"));
    const result = await choose("growth");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("The plan could not be switched");
    // The optimistic `agencies.plan` write is downstream of the Stripe call,
    // so a refusal must leave the customer on the tier they are paying for.
    expect(writes).toHaveLength(0);
  });

  it("refuses the portal in words when there is no billing account yet", async () => {
    agencyRow = { stripe_customer_id: null, stripe_subscription_id: null };
    const { createBillingPortalSession } = await import("../billing");
    const result = await createBillingPortalSession("payment_method");
    expect(result).toEqual({ ok: false, error: "There is no billing account yet — choose a plan first." });
  });

  it("says the portal could not be opened rather than throwing a digest", async () => {
    agencyRow = { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" };
    portalCreate.mockRejectedValueOnce(new Error("Invalid API Key provided: sk_test_********ess2"));
    const { createBillingPortalSession } = await import("../billing");
    const result = await createBillingPortalSession("payment_method");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("The billing portal could not be opened");
    expect(result.error).toContain("nothing about your account has changed");
    expect(result.error).not.toContain("sk_test");
  });

  // Not covered here: the "no price configured" branch. PLAN_PRICE_IDS is
  // built from env at module load - unlike planForPriceId, which re-reads it
  // per call so a rotated id takes effect on the next webhook - so a test
  // cannot unset one after importing the action.
});
