import { describe, it, expect } from "vitest";
import { ONBOARDING_STEPS, stepCompletionMessage } from "../onboarding-steps";

// ---------------------------------------------------------------------------
// P0-O5: "Rank tracking starts on the next run" - not on the free tier
// ---------------------------------------------------------------------------
//
// `cron/serp` calls `entitledToScheduledWork` and refuses a no-plan account
// before it looks at a single keyword, and the AI-visibility sweep and the
// backlink pass are in the same route. So the message a brand-new signup saw
// after adding its first keyword described work that would never run for it.

const step = (id: string) => {
  const found = ONBOARDING_STEPS.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

describe("stepCompletionMessage", () => {
  it("promises the nightly run only to an account the nightly run serves", () => {
    const keywords = step("add-keywords");
    expect(stepCompletionMessage(keywords, true)).toMatch(/nightly rank tracker picks them up/i);
    expect(stepCompletionMessage(keywords, false)).not.toMatch(/next run/i);
    expect(stepCompletionMessage(keywords, false)).toMatch(/accounts on a plan/i);
  });

  it("leaves a step with no entitlement-dependent variant alone", () => {
    for (const s of ONBOARDING_STEPS.filter((x) => !x.completionMessageUnscheduled)) {
      expect(stepCompletionMessage(s, false)).toBe(s.completionMessage);
      expect(stepCompletionMessage(s, true)).toBe(s.completionMessage);
    }
  });

  it("has a distinct variant wherever one is declared", () => {
    for (const s of ONBOARDING_STEPS.filter((x) => x.completionMessageUnscheduled)) {
      expect(s.completionMessageUnscheduled).not.toBe(s.completionMessage);
    }
  });
});

describe("the keyword step's own copy", () => {
  it("does not claim SERP position is tracked for every keyword regardless of tier", () => {
    // The description used to read "search volume, ranking difficulty, and
    // SERP position for every keyword", which the free tier never gets.
    expect(step("add-keywords").description).not.toMatch(/SERP position for every keyword/i);
    expect(step("add-keywords").description).toMatch(/nightly rank tracker/i);
  });
});
