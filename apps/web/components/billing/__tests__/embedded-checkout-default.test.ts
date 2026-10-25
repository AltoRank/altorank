import { afterEach, describe, expect, it, vi } from "vitest";

// The trial's card form opens on Stripe's hosted page unless a deploy opts in
// to Embedded Checkout with both variables (components/billing/embedded-checkout.tsx).
vi.mock("@/app/actions/billing", () => ({ createEmbeddedCheckout: vi.fn() }));

async function available(env: Record<string, string | undefined>): Promise<boolean> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  return (await import("../embedded-checkout")).embeddedCheckoutAvailable;
}

afterEach(() => vi.unstubAllEnvs());

describe("embeddedCheckoutAvailable", () => {
  it("is off with a publishable key alone: the hosted page is the default", async () => {
    expect(await available({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x", NEXT_PUBLIC_STRIPE_EMBEDDED_CHECKOUT: "" })).toBe(false);
  });

  it("is on only with a key and the opt-in", async () => {
    expect(await available({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_x", NEXT_PUBLIC_STRIPE_EMBEDDED_CHECKOUT: "true" })).toBe(true);
  });

  it("stays off when opted in without a key", async () => {
    expect(await available({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "", NEXT_PUBLIC_STRIPE_EMBEDDED_CHECKOUT: "true" })).toBe(false);
  });
});
