import { describe, it, expect } from "vitest";
import { PLAN_WORKSPACE_LIMITS, workspaceLimitMessage } from "../workspaces";

describe("workspace limits", () => {
  it("one before a plan, three on Managed, unlimited on Agency", () => {
    expect(PLAN_WORKSPACE_LIMITS.none).toBe(1);
    expect(PLAN_WORKSPACE_LIMITS.starter).toBe(3);
    expect(PLAN_WORKSPACE_LIMITS.growth).toBeNull();
  });
  it("says what to do, not just no", () => {
    expect(workspaceLimitMessage({ limit: 1, used: 1, remaining: 0, reason: "no-plan", plan: null })).toContain("Choose a plan");
    expect(workspaceLimitMessage({ limit: 3, used: 3, remaining: 0, reason: "plan", plan: "starter" })).toContain("3 workspaces");
  });

  it("does not say 'all 3 are in use' to an account that has five", () => {
    // A downgrade removes no workspaces, so `used` outruns `limit`. The
    // sentence used to read "This plan includes 3 workspaces and all 3 are in
    // use" on a page listing five of them.
    const msg = workspaceLimitMessage({ limit: 3, used: 5, remaining: 0, reason: "plan", plan: "starter" });
    expect(msg).toContain("includes 3 workspaces and 5 are in use");
    expect(msg).toContain("None has been removed");
    expect(msg).not.toContain("all 3 are in use");
  });

  it("counts honestly on the free tier too", () => {
    const msg = workspaceLimitMessage({ limit: 1, used: 4, remaining: 0, reason: "no-plan", plan: null });
    expect(msg).toContain("4 workspaces exist");
    expect(msg).toContain("None has been removed");
  });
});
