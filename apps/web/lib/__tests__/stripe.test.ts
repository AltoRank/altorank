import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { planForPriceId, isSelfServePlan, PLAN_ARTICLE_LIMITS, PLAN_PRICES } from "@/lib/stripe";

// The inverse of PLAN_PRICE_IDS, which is how the webhook learns what a
// customer bought. Getting it wrong is a revenue bug in both directions: a
// price that resolves to the wrong tier meters the wrong ceiling, and a price
// that resolves to nothing leaves agencies.plan on its 'starter' default.

const ENV = { ...process.env };

beforeEach(() => {
  process.env.STRIPE_PRICE_STARTER = "price_S_m";
  process.env.STRIPE_PRICE_STARTER_YEARLY = "price_S_y";
  process.env.STRIPE_PRICE_GROWTH = "price_G_m";
  process.env.STRIPE_PRICE_GROWTH_YEARLY = "price_G_y";
});

afterEach(() => {
  process.env = { ...ENV };
});

describe("planForPriceId", () => {
  it("resolves both intervals of both self-serve tiers", () => {
    expect(planForPriceId("price_S_m")).toBe("starter");
    expect(planForPriceId("price_S_y")).toBe("starter");
    expect(planForPriceId("price_G_m")).toBe("growth");
    expect(planForPriceId("price_G_y")).toBe("growth");
  });

  it("returns undefined rather than a guess for anything else", () => {
    expect(planForPriceId("price_retired_2024")).toBeUndefined();
    expect(planForPriceId("")).toBeUndefined();
    expect(planForPriceId(null)).toBeUndefined();
    expect(planForPriceId(undefined)).toBeUndefined();
  });

  it("reads the environment on every call, not at import", () => {
    // A price id rotated in the environment has to take effect on the next
    // event, without a redeploy of a module that captured it.
    process.env.STRIPE_PRICE_GROWTH = "price_G_m_v2";
    expect(planForPriceId("price_G_m_v2")).toBe("growth");
    expect(planForPriceId("price_G_m")).toBeUndefined();
  });

  it("does not match an unset price id against an undefined variable", () => {
    delete process.env.STRIPE_PRICE_STARTER_YEARLY;
    expect(planForPriceId(undefined)).toBeUndefined();
    expect(planForPriceId("price_S_m")).toBe("starter");
  });
});

describe("isSelfServePlan", () => {
  it("accepts only the two tiers a customer can buy without talking to us", () => {
    expect(isSelfServePlan("starter")).toBe(true);
    expect(isSelfServePlan("growth")).toBe(true);
    // 'scale' is sales-led, so it is never what a checkout session bought.
    expect(isSelfServePlan("scale")).toBe(false);
    expect(isSelfServePlan("enterprise")).toBe(false);
    expect(isSelfServePlan(undefined)).toBe(false);
    expect(isSelfServePlan(null)).toBe(false);
    expect(isSelfServePlan(7)).toBe(false);
  });
});

describe("the ladder the webhook writes into", () => {
  it("still meters the two tiers differently, which is why plan must be written", () => {
    expect(PLAN_ARTICLE_LIMITS.starter).toBe(100);
    expect(PLAN_ARTICLE_LIMITS.growth).toBe(400);
    expect(PLAN_PRICES.starter).toBe("€69");
    expect(PLAN_PRICES.growth).toBe("€199");
  });
});
