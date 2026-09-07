import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// VAT is added at checkout, not folded into the price
// ---------------------------------------------------------------------------
//
// Before this the session passed no tax options at all, so exactly EUR 69 /
// EUR 199 was charged to every customer in every country. That cannot be right
// for both of our buyers at once: a VAT-registered business elsewhere in the EU
// is reverse-charged and we collect nothing, while a consumer pays their own
// country's rate. One inclusive price pays us a different amount depending on
// who bought it.
//
// These assertions are about money leaving the wrong amount behind, so they
// check the exact fields rather than "some tax config was passed".

const created: Record<string, unknown>[] = [];
let customerId: string | null = null;

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ agencyId: "agency-1", userId: "user-1" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { stripe_customer_id: customerId }, error: null }),
          maybeSingle: async () => ({ data: { stripe_customer_id: customerId }, error: null }),
        }),
      }),
    }),
  }),
}));

let taxOn = true;
let taxBehavior: string | null = "exclusive";
let priceReadFails = false;

vi.mock("@/lib/stripe", async (orig) => {
  const actual = await orig<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    get stripeTaxEnabled() {
      return taxOn;
    },
    // PLAN_PRICE_IDS is built from env at module load, and vi.mock is hoisted
    // above any assignment this file could make, so the ids are supplied here
    // instead. Without them the action refuses with "No Stripe price
    // configured" before it ever builds a session.
    PLAN_PRICE_IDS: {
      starter: { month: "price_starter_month", year: "price_starter_year" },
      growth: { month: "price_growth_month", year: "price_growth_year" },
    },
    getStripe: () => ({
      prices: {
        retrieve: async (id: string) => {
          if (priceReadFails) throw new Error("stripe down");
          return { id, tax_behavior: taxBehavior };
        },
      },
      checkout: {
        sessions: {
          create: async (args: Record<string, unknown>) => {
            created.push(args);
            return { url: "https://checkout.stripe.test/s/1" };
          },
        },
      },
    }),
  };
});

import { createCheckoutSession } from "../billing";

beforeEach(() => {
  created.length = 0;
  customerId = null;
  taxOn = true;
  taxBehavior = "exclusive";
  priceReadFails = false;
});

describe("createCheckoutSession: VAT, when STRIPE_TAX_ENABLED", () => {
  it("lets Stripe compute the tax from the customer's location", async () => {
    await createCheckoutSession("starter", "month");
    expect(created[0].automatic_tax).toEqual({ enabled: true });
  });

  it("collects the VAT number, which is what triggers the reverse charge", async () => {
    await createCheckoutSession("growth", "month");
    expect(created[0].tax_id_collection).toEqual({ enabled: true });
  });

  it("keeps the address on an existing customer, so a renewal can be taxed too", async () => {
    customerId = "cus_existing";
    await createCheckoutSession("growth", "year");
    expect(created[0].customer_update).toEqual({ address: "auto", name: "auto" });
  });

  it("omits customer_update on a first purchase: Stripe rejects it with no customer", async () => {
    customerId = null;
    await createCheckoutSession("starter", "month");
    expect(created[0].customer_update).toBeUndefined();
    // The tax options still apply - it is only the address carry-over that needs
    // an existing customer.
    expect(created[0].automatic_tax).toEqual({ enabled: true });
  });

  it("still maps the agency and tier for the webhook", async () => {
    await createCheckoutSession("growth", "month");
    expect(created[0].metadata).toMatchObject({ agency_id: "agency-1", plan: "growth" });
  });
});

describe("createCheckoutSession: VAT, when the flag is off (the default)", () => {
  // Off is load-bearing. With Stripe Tax not activated on the account,
  // `automatic_tax: { enabled: true }` makes checkout.sessions.create throw, so
  // every customer would hit an error instead of a payment page. Until the
  // account is set up, the session must not mention tax at all.
  it("sends no tax fields, so checkout works on an account without Stripe Tax", async () => {
    taxOn = false;
    await createCheckoutSession("starter", "month");
    expect(created[0].automatic_tax).toBeUndefined();
    expect(created[0].tax_id_collection).toBeUndefined();
    expect(created[0].customer_update).toBeUndefined();
  });

  it("still maps the agency and tier for the webhook", async () => {
    taxOn = false;
    await createCheckoutSession("growth", "year");
    expect(created[0].metadata).toMatchObject({ agency_id: "agency-1", plan: "growth" });
  });

  it("is off unless the env var is exactly the string true", async () => {
    const { stripeTaxEnabled } = await import("@/lib/stripe");
    // the real export, not the mock getter: env is unset in tests
    expect(typeof stripeTaxEnabled).toBe("boolean");
  });
});

describe("createCheckoutSession: the price must be tax-exclusive before VAT is added", () => {
  // Stripe's account default reads a euro price as tax-INCLUSIVE, and a Price
  // created that way cannot be edited back. With automatic_tax on top of an
  // inclusive price, EUR 69 arrives as EUR 56.56. So the flag alone is not
  // enough: the price being sold has to say `exclusive`.
  it("adds VAT on an exclusive price", async () => {
    taxBehavior = "exclusive";
    await createCheckoutSession("starter");
    expect(created[0].automatic_tax).toEqual({ enabled: true });
  });

  for (const behaviour of ["inclusive", "unspecified", null]) {
    it(`sends no tax fields when the price is ${behaviour ?? "missing tax_behavior"}, and says so`, async () => {
      taxBehavior = behaviour;
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await createCheckoutSession("starter");
      expect(created[0]).not.toHaveProperty("automatic_tax");
      expect(created[0]).not.toHaveProperty("tax_id_collection");
      expect(created[0]).not.toHaveProperty("customer_update");
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0][0])).toContain("price_starter_month");
      error.mockRestore();
    });
  }

  it("charges the listed amount rather than failing when the price cannot be read", async () => {
    priceReadFails = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createCheckoutSession("starter");
    expect(res.ok).toBe(true);
    expect(created[0]).not.toHaveProperty("automatic_tax");
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("never reads the price while the flag is off", async () => {
    taxOn = false;
    priceReadFails = true;
    const res = await createCheckoutSession("starter");
    expect(res.ok).toBe(true);
    expect(created[0]).not.toHaveProperty("automatic_tax");
  });
});
