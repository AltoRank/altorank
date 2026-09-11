import { describe, expect, it } from "vitest";
import { ONBOARDING_PATH, wizardStepPath } from "../steps";

// One screen since 2026-09-11, so there is one address. The lifecycle email
// that brings a stalled account back is the caller that matters: it used to
// deep-link to the Articles screen by number, and a number is what a
// five-step wizard had and a one-screen check does not.
describe("wizardStepPath", () => {
  it("is the onboarding page, with no step to name", () => {
    expect(wizardStepPath()).toBe("/onboarding");
    expect(wizardStepPath()).toBe(ONBOARDING_PATH);
  });
});
