import { describe, it, expect } from "vitest";
import { BODY_STAGE_S, EXPECTED_GATE_S, EXPECTED_RUN_S, expectedRunPhrase } from "../run-timing";
import { initialOnboardingState, onboardingOutcome } from "../events";

// The run screen said "This takes about a minute" while the measured first
// look (outline gate plus the first body) takes about three. The sentence is
// now derived from the measurement, so the two cannot drift apart again.

describe("how long a first look takes", () => {
  it("is the gate plus the first body", () => {
    expect(EXPECTED_RUN_S).toBe(EXPECTED_GATE_S + BODY_STAGE_S.thinking + BODY_STAGE_S.writing + BODY_STAGE_S.finishing);
    expect(expectedRunPhrase()).toBe(`about ${Math.round(EXPECTED_RUN_S / 60)} minutes`);
  });

  it("the run screen says the measured time, not a minute", () => {
    const line = onboardingOutcome(initialOnboardingState()).line;
    expect(line).toContain(`This takes ${expectedRunPhrase()}.`);
    expect(line).not.toContain("about a minute");
  });
});
