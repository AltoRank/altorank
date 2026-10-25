import { describe, it, expect } from "vitest";
import {
  dunningInfo,
  dunningState,
  firstChargeFailed,
  GRACE_DAYS,
  graceEndsAt,
  isPastDueStatus,
  planEntitled,
  TRIAL_END_MARGIN_MS,
} from "../dunning";
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

// Assessment 2026-10-25: a trial whose end webhook never arrived stayed
// entitled forever, and a trial whose first charge failed got the paying
// customer's week of grace.
describe("planEntitled bounds a trial by its end date", () => {
  const ends = "2026-10-20T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(ends) + ms);
  const trialing = { plan_status: "trialing", trial_ends_at: ends };

  it("is entitled through the trial and the margin after it", () => {
    expect(planEntitled(trialing, at(-3 * 24 * 60 * 60 * 1000))).toBe(true);
    expect(planEntitled(trialing, at(TRIAL_END_MARGIN_MS - 1))).toBe(true);
  });

  it("is not entitled once the trial and the margin are over and the row still says trialing", () => {
    expect(planEntitled(trialing, at(TRIAL_END_MARGIN_MS))).toBe(false);
    expect(planEntitled(trialing, at(30 * 24 * 60 * 60 * 1000))).toBe(false);
  });

  it("leaves a Shopify trial and a trial with no end date alone", () => {
    expect(planEntitled({ ...trialing, billing_provider: "shopify" }, at(30 * 24 * 60 * 60 * 1000))).toBe(true);
    expect(planEntitled({ plan_status: "trialing", trial_ends_at: null }, at(30 * 24 * 60 * 60 * 1000))).toBe(true);
  });
});

describe("a failed first charge gets no grace", () => {
  const trialEnd = "2026-10-20T10:00:00.000Z";
  const hours = (n: number) => new Date(Date.parse(trialEnd) + n * 60 * 60 * 1000).toISOString();

  it("lapses at once when the charge that failed is the trial's conversion", () => {
    const row = { plan_status: "past_due", trial_ends_at: trialEnd, payment_failed_at: hours(1) };
    const now = new Date(hours(2));
    expect(firstChargeFailed(row)).toBe(true);
    expect(dunningState(row, now)).toBe("lapsed");
    expect(planEntitled(row, now)).toBe(false);
    expect(dunningInfo(row, now)).toEqual({ state: "lapsed", graceEndsAt: null, firstCharge: true });
  });

  it("keeps the grace window for a renewal that fails after a paid period", () => {
    const row = { plan_status: "past_due", trial_ends_at: trialEnd, payment_failed_at: hours(24 * 31) };
    const now = new Date(hours(24 * 32));
    expect(firstChargeFailed(row)).toBe(false);
    expect(dunningState(row, now)).toBe("grace");
    expect(planEntitled(row, now)).toBe(true);
  });

  it("keeps the grace window for an account that never had a trial", () => {
    const row = { plan_status: "past_due", trial_ends_at: null, payment_failed_at: hours(0) };
    expect(firstChargeFailed(row)).toBe(false);
    expect(planEntitled(row, new Date(hours(24)))).toBe(true);
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
