import { describe, it, expect, vi } from "vitest";
import { planCardRelation, priceForInterval } from "../plan-interval";

// A yearly subscriber read "€69 /mo" on Billing, and the current tier's card
// could never switch between monthly and yearly.

describe("priceForInterval", () => {
  const managed = { monthly: "€69", yearly: "€690" };
  it("states the yearly price per year, and the monthly one per month", () => {
    expect(priceForInterval(managed, "year")).toBe("€690 /yr");
    expect(priceForInterval(managed, "month")).toBe("€69 /mo");
  });
  it("falls back to the monthly figure when the interval is unknown, as before", () => {
    expect(priceForInterval(managed, null)).toBe("€69 /mo");
  });
  it("gives a sales-led tier no period", () => {
    expect(priceForInterval({ monthly: "Let's talk", yearly: "Let's talk" }, "month", { sales: true })).toBe("Let's talk");
  });
});

describe("planCardRelation", () => {
  const base = { isActive: true, currentTier: "starter", currentInterval: "year" as const, tier: "starter" };
  it("is current only at the interval being paid", () => {
    expect(planCardRelation({ ...base, shownInterval: "year" })).toBe("current");
    expect(planCardRelation({ ...base, shownInterval: "month" })).toBe("other-interval");
  });
  it("is another plan for another tier, or when nothing is paid for", () => {
    expect(planCardRelation({ ...base, tier: "growth", shownInterval: "year" })).toBe("other");
    expect(planCardRelation({ ...base, isActive: false, shownInterval: "year" })).toBe("other");
  });
  it("lets the tier decide when the interval could not be read", () => {
    expect(planCardRelation({ ...base, currentInterval: null, shownInterval: "month" })).toBe("current");
  });
});

describe("readSubscriptionInterval", () => {
  it("reads the interval off the subscription, and says nothing rather than failing the page", async () => {
    const retrieve = vi.fn();
    vi.doMock("@/lib/stripe", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/stripe")>()),
      billingEnabled: true,
      getStripe: () => ({ subscriptions: { retrieve } }),
    }));
    const { readSubscriptionInterval } = await import("../subscription-interval");
    retrieve.mockResolvedValueOnce({ items: { data: [{ price: { id: "p", recurring: { interval: "year" } } }] } });
    expect(await readSubscriptionInterval("sub_1")).toBe("year");
    retrieve.mockRejectedValueOnce(new Error("timeout"));
    expect(await readSubscriptionInterval("sub_1")).toBeNull();
    expect(await readSubscriptionInterval(null)).toBeNull();
    vi.doUnmock("@/lib/stripe");
  });
});
