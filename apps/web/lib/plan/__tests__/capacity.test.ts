import { describe, it, expect } from "vitest";
import { computeCapacity, describeSlots } from "../capacity";
import { PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";

describe("computeCapacity", () => {
  it("leaves cap minus scheduled available", () => {
    const c = computeCapacity({ scheduled: 12, weeklyLimit: 7 });
    expect(c).toEqual({
      cap: PLAN_MAX_ENTRIES, scheduled: 12, articles: 12, improvements: 0, available: 48, weeklyLimit: 7, monthlyTarget: 30,
    });
  });
  it("a scheduled improvement holds a slot like a planned keyword", () => {
    const c = computeCapacity({ scheduled: 28, improvements: 2, weeklyLimit: 7 });
    expect(c).toMatchObject({ scheduled: 30, articles: 28, improvements: 2, available: 30 });
  });
  it("improvements alone can fill the cap", () => {
    expect(computeCapacity({ scheduled: 59, improvements: 3, weeklyLimit: 7 }).available).toBe(0);
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

describe("describeSlots", () => {
  it("names both kinds only when both are held", () => {
    expect(describeSlots(3, 1)).toBe("3 articles + 1 improvement");
    expect(describeSlots(1, 2)).toBe("1 article + 2 improvements");
    expect(describeSlots(3, 0)).toBe("3 articles");
    expect(describeSlots(0, 0)).toBe("0 articles");
  });
});
