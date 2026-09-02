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
});
