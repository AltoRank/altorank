import { describe, it, expect } from "vitest";
import { computeCapacity } from "../capacity";
import { PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";

describe("computeCapacity", () => {
  it("leaves cap minus scheduled available", () => {
    const c = computeCapacity({ scheduled: 12, weeklyLimit: 7 });
    expect(c).toEqual({ cap: PLAN_MAX_ENTRIES, scheduled: 12, available: 48, weeklyLimit: 7, monthlyTarget: 30 });
  });
  it("never reports negative room when the plan is over the cap", () => {
    expect(computeCapacity({ scheduled: 75, weeklyLimit: 1 }).available).toBe(0);
  });
  it("uses the paid default when the column is unset, and 0 when paused", () => {
    expect(computeCapacity({ scheduled: 0, weeklyLimit: null }).weeklyLimit).toBe(7);
    expect(computeCapacity({ scheduled: 0, weeklyLimit: 0 })).toMatchObject({ weeklyLimit: 0, monthlyTarget: 0 });
  });
  it("quotes the month with 52/12, not 4", () => {
    expect(computeCapacity({ scheduled: 0, weeklyLimit: 3 }).monthlyTarget).toBe(13);
  });
});
