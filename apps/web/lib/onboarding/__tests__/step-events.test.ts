import { describe, expect, it } from "vitest";
import { stepContext, stepEventId } from "../step-events";
import { ONBOARDING_STEPS, isOnboardingStep } from "../step-names";

describe("onboarding.step events", () => {
  it("carry the step, the ids and bounded numbers, nothing else", () => {
    expect(stepContext({ workspaceId: "w", accountId: "a", userId: "u", step: "site_read_finished", ms: 1234.6 })).toEqual({ step: "site_read_finished", userId: "u", ms: 1235 });
    expect(stepContext({ workspaceId: "w", accountId: null, userId: null, step: "gate_shown", secondsSinceSignup: -3, ms: Number.NaN })).toEqual({ step: "gate_shown" });
    expect(stepContext({ workspaceId: "w", accountId: null, userId: null, step: "site_read_finished", ms: 9e12 }).ms).toBe(3_600_000);
  });

  it("have one id per step per workspace, shaped as a uuid", () => {
    const id = stepEventId("ws-1", "gate_shown");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stepEventId("ws-1", "gate_shown")).toBe(id);
    expect(stepEventId("ws-2", "gate_shown")).not.toBe(id);
    expect(stepEventId("ws-1", "trial_clicked")).not.toBe(id);
  });

  it("name every step the screens report", () => {
    expect(ONBOARDING_STEPS).toContain("checkout_returned");
    expect(isOnboardingStep("plan_clicked")).toBe(true);
    expect(isOnboardingStep("drop table")).toBe(false);
  });
});
