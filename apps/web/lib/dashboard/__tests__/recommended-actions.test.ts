import { describe, it, expect } from "vitest";
import { recommendedActions } from "../recommended-actions";

const healthy = {
  cmsConnected: true,
  gscConnected: true,
  pendingReviews: 0,
  scheduledCount: 12,
  keywordCount: 40,
  setupUnfinished: false,
};

describe("recommendedActions", () => {
  it("recommends nothing when there is nothing to do", () => {
    expect(recommendedActions(healthy)).toEqual([]);
  });
  it("names every gap, drafts first, each with a consequence", () => {
    const out = recommendedActions({ ...healthy, cmsConnected: false, gscConnected: false, pendingReviews: 3, scheduledCount: 0 });
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
  it("sends a workspace with no keywords to research, not to a Plan button that cannot work", () => {
    // Planning reads keywords that already exist. Offering "Plan" here ran the
    // action, scheduled nothing, and reported "no keyword qualifies" after the
    // click - a promise the state could not keep.
    const out = recommendedActions({ ...healthy, scheduledCount: 0, keywordCount: 0 });
    expect(out.map((a) => a.id)).toEqual(["research-keywords"]);
    expect(out[0].href).toBe("/keywords");
    expect(out[0].run).toBeUndefined();
    expect(out[0].consequence).toMatch(/nothing to place/);
  });
  it("offers the way back into an unfinished wizard, before anything else", () => {
    // Nothing else in the app links to /onboarding, and the layout stops
    // redirecting there as soon as step 1 has written a business profile. On a
    // half-set-up site this card is the only route back to the screen that
    // writes the plan and the first draft, so it goes first.
    const out = recommendedActions({ ...healthy, setupUnfinished: true, scheduledCount: 0, keywordCount: 0 });
    expect(out.map((a) => a.id)).toEqual(["finish-setup", "research-keywords"]);
    expect(out[0].href).toBe("/onboarding");
  });
  it("says nothing about setup once the wizard is finished or skipped", () => {
    expect(recommendedActions(healthy).map((a) => a.id)).not.toContain("finish-setup");
  });
});
