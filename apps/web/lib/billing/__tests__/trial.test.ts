import { describe, expect, it } from "vitest";
import { trialEligible, trialEndsLabel, trialInfo } from "@/lib/billing/trial";
import { planEntitled } from "@/lib/billing/dunning";

describe("trialEligible", () => {
  it("is true for a fresh account", () => {
    expect(trialEligible({ plan_status: "inactive" })).toBe(true);
    expect(trialEligible(null)).toBe(true);
  });
  it("is false once the account has had its trial, whatever happened after", () => {
    expect(trialEligible({ plan_status: "inactive", trial_ends_at: "2026-09-16T00:00:00Z" })).toBe(false);
    expect(trialEligible({ plan_status: "canceled", trial_ends_at: "2026-09-16T00:00:00Z" })).toBe(false);
  });
  it("is false while a subscription exists", () => {
    expect(trialEligible({ plan_status: "active", stripe_subscription_id: "sub_1" })).toBe(false);
    expect(trialEligible({ plan_status: "trialing", stripe_subscription_id: "sub_1" })).toBe(false);
  });
});

describe("trialInfo", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  it("counts whole days left, never negative", () => {
    expect(trialInfo({ plan_status: "trialing", trial_ends_at: "2026-09-16T12:00:00Z" }, now)?.daysLeft).toBe(7);
    expect(trialInfo({ plan_status: "trialing", trial_ends_at: "2026-09-10T00:00:00Z" }, now)?.daysLeft).toBe(1);
    expect(trialInfo({ plan_status: "trialing", trial_ends_at: "2026-09-01T00:00:00Z" }, now)?.daysLeft).toBe(0);
  });
  it("is null unless the plan is a trial", () => {
    expect(trialInfo({ plan_status: "active", trial_ends_at: "2026-09-16T12:00:00Z" }, now)).toBeNull();
    expect(trialInfo({ plan_status: "trialing" }, now)).toBeNull();
  });
  it("labels the end", () => {
    expect(trialEndsLabel({ endsAt: "", daysLeft: 3 })).toBe("Trial ends in 3 days");
    expect(trialEndsLabel({ endsAt: "", daysLeft: 1 })).toBe("Trial ends tomorrow");
    expect(trialEndsLabel({ endsAt: "", daysLeft: 0 })).toBe("Trial ends today");
  });
});

describe("planEntitled during a trial", () => {
  it("treats trialing as the paid plan it is", () => {
    expect(planEntitled({ plan_status: "trialing" })).toBe(true);
  });
});
