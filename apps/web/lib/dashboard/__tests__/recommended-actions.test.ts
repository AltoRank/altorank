import { describe, it, expect } from "vitest";
import { recommendedActions } from "../recommended-actions";

const healthy = { cmsConnected: true, gscConnected: true, pendingReviews: 0, scheduledCount: 12 };

describe("recommendedActions", () => {
  it("recommends nothing when there is nothing to do", () => {
    expect(recommendedActions(healthy)).toEqual([]);
  });
  it("names every gap, drafts first, each with a consequence", () => {
    const out = recommendedActions({ cmsConnected: false, gscConnected: false, pendingReviews: 3, scheduledCount: 0 });
    expect(out.map((a) => a.id)).toEqual(["review-drafts", "connect-cms", "plan-month", "connect-gsc"]);
    expect(out[0].title).toBe("3 drafts are waiting for your yes");
    for (const a of out) expect(a.consequence.length).toBeGreaterThan(20);
    // Every card has exactly one way to act on it.
    for (const a of out) expect(Boolean(a.href) !== Boolean(a.run)).toBe(true);
  });
  it("singularises one draft", () => {
    expect(recommendedActions({ ...healthy, pendingReviews: 1 })[0].title).toBe("1 draft is waiting for your yes");
  });
  it("offers to plan only when the calendar is empty", () => {
    expect(recommendedActions({ ...healthy, scheduledCount: 0 }).map((a) => a.id)).toEqual(["plan-month"]);
    expect(recommendedActions({ ...healthy, scheduledCount: 1 })).toEqual([]);
  });
});
