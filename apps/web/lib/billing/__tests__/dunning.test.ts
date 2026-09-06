import { describe, it, expect } from "vitest";
import { dunningInfo, dunningState, GRACE_DAYS, graceEndsAt, isPastDueStatus, planEntitled } from "../dunning";
import { subscriptionSwitchable } from "../plan-switch";

// A failed renewal used to make the account a free one on the spot: past_due
// was not active, so the paid gates shut and the ladder offered "Choose
// Managed" to a Managed customer. These pin the grace window that replaces it.

const failed = "2026-09-01T10:00:00.000Z";
const day = (n: number) => new Date(Date.parse(failed) + n * 24 * 60 * 60 * 1000);

describe("dunningState", () => {
  it("is none for a paid-up plan and for no plan at all", () => {
    expect(dunningState({ plan_status: "active", payment_failed_at: null })).toBe("none");
    expect(dunningState({ plan_status: "inactive" })).toBe("none");
    expect(dunningState({ plan_status: "canceled", payment_failed_at: failed })).toBe("none");
  });

  it("is grace for the window after the first failed invoice", () => {
    expect(dunningState({ plan_status: "past_due", payment_failed_at: failed }, day(0))).toBe("grace");
    expect(dunningState({ plan_status: "past_due", payment_failed_at: failed }, day(GRACE_DAYS - 0.01))).toBe("grace");
  });

  it("lapses on the day the window ends", () => {
    expect(dunningState({ plan_status: "past_due", payment_failed_at: failed }, day(GRACE_DAYS))).toBe("lapsed");
    expect(dunningState({ plan_status: "past_due", payment_failed_at: failed }, day(30))).toBe("lapsed");
  });

  it("treats past_due with no recorded failure as lapsed, not as an open-ended grace", () => {
    expect(dunningState({ plan_status: "past_due", payment_failed_at: null })).toBe("lapsed");
    expect(dunningState({ plan_status: "past_due", payment_failed_at: "not a date" })).toBe("lapsed");
  });

  it("counts unpaid the same as past_due", () => {
    expect(isPastDueStatus("unpaid")).toBe(true);
    expect(dunningState({ plan_status: "unpaid", payment_failed_at: failed }, day(1))).toBe("grace");
  });
});

describe("planEntitled", () => {
  it("keeps the paid tier open inside the grace window and shuts it after", () => {
    expect(planEntitled({ plan_status: "active" })).toBe(true);
    expect(planEntitled({ plan_status: "past_due", payment_failed_at: failed }, day(3))).toBe(true);
    expect(planEntitled({ plan_status: "past_due", payment_failed_at: failed }, day(8))).toBe(false);
    expect(planEntitled({ plan_status: "inactive" })).toBe(false);
  });
});

describe("graceEndsAt / dunningInfo", () => {
  it("ends GRACE_DAYS after the failure", () => {
    expect(graceEndsAt(failed)?.toISOString()).toBe(day(GRACE_DAYS).toISOString());
    expect(graceEndsAt(null)).toBeNull();
  });

  it("hands the page the state and the date", () => {
    expect(dunningInfo({ plan_status: "active" })).toBeNull();
    expect(dunningInfo({ plan_status: "past_due", payment_failed_at: failed }, day(1))).toEqual({
      state: "grace",
      graceEndsAt: day(GRACE_DAYS).toISOString(),
    });
    expect(dunningInfo({ plan_status: "past_due", payment_failed_at: null })).toEqual({
      state: "lapsed",
      graceEndsAt: null,
    });
  });
});

describe("subscriptionSwitchable", () => {
  it("switches in place whenever Stripe still holds a billing subscription", () => {
    for (const plan_status of ["active", "trialing", "past_due", "unpaid"]) {
      expect(subscriptionSwitchable({ stripe_subscription_id: "sub_1", plan_status })).toBe(true);
    }
  });

  it("starts a new checkout when there is nothing live to change", () => {
    expect(subscriptionSwitchable({ stripe_subscription_id: null, plan_status: "active" })).toBe(false);
    expect(subscriptionSwitchable({ stripe_subscription_id: "sub_old", plan_status: "canceled" })).toBe(false);
    expect(subscriptionSwitchable({ stripe_subscription_id: "sub_old", plan_status: "inactive" })).toBe(false);
  });
});
