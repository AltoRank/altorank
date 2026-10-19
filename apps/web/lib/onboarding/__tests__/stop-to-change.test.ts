import { describe, expect, it } from "vitest";
import { offerStopToChange, stoppableToChange } from "../stop-to-change";
import { initialOnboardingState, type OnboardingState, type OnboardingStep } from "../events";

// When the run screen offers "Wrong? Fix it and start over" beside "What we
// understood", and when it does not (lib/onboarding/stop-to-change.ts).

const steps = (...set: Array<[OnboardingStep["phase"], OnboardingStep["status"]]>): OnboardingStep[] =>
  initialOnboardingState().steps.map((s) => {
    const hit = set.find(([phase]) => phase === s.phase);
    return hit ? { phase: s.phase, status: hit[1] } : s;
  });

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({ ...initialOnboardingState(), ...over });

const READING = steps(["scanning", "active"]);
const FINDING = steps(["scanning", "done"], ["keywords", "active"], ["pages", "active"]);
const ARTICLE = { id: "a1", title: "T", keyword: "k", wordCount: 900, verdict: "clean" as const };

const allowed = { restartable: true, firstAttempted: false };

describe("stoppableToChange", () => {
  it("holds while the run is reading the site or finding searches", () => {
    expect(stoppableToChange(initialOnboardingState().steps)).toBe(true);
    expect(stoppableToChange(READING)).toBe(true);
    expect(stoppableToChange(FINDING)).toBe(true);
    // A run no worker has claimed yet has no steps at all.
    expect(stoppableToChange([])).toBe(true);
    expect(stoppableToChange(null)).toBe(true);
  });

  it("ends once the searches are settled, whichever way", () => {
    for (const status of ["done", "skipped", "failed"] as const) {
      expect(stoppableToChange(steps(["scanning", "done"], ["keywords", status]))).toBe(false);
    }
  });

  it("ends once planning or drafting has begun", () => {
    expect(stoppableToChange(steps(["keywords", "active"], ["planning", "active"]))).toBe(false);
    expect(stoppableToChange(steps(["keywords", "active"], ["drafting", "active"]))).toBe(false);
  });
});

describe("offerStopToChange: when the link shows", () => {
  it("shows while the run reads the site and the gate would start one more", () => {
    expect(offerStopToChange(state({ steps: READING }), allowed)).toBe(true);
    expect(offerStopToChange(state({ steps: FINDING }), allowed)).toBe(true);
  });

  it("hides until the server has answered, and when it said no", () => {
    expect(offerStopToChange(state({ steps: READING }), { restartable: null, firstAttempted: false })).toBe(false);
    // PRE_TRIAL_SETUP_RUNS, counting this run: this is the last one.
    expect(offerStopToChange(state({ steps: READING }), { restartable: false, firstAttempted: false })).toBe(false);
  });

  it("hides once the one pre-trial article has been claimed", () => {
    expect(offerStopToChange(state({ steps: READING }), { restartable: true, firstAttempted: true })).toBe(false);
  });

  it("hides once the searches are found, planning has begun, or there is an article", () => {
    expect(offerStopToChange(state({ steps: steps(["scanning", "done"], ["keywords", "done"], ["pages", "active"]) }), allowed)).toBe(false);
    expect(offerStopToChange(state({ steps: steps(["keywords", "done"], ["planning", "active"]) }), allowed)).toBe(false);
    expect(offerStopToChange(state({ steps: READING, article: ARTICLE }), allowed)).toBe(false);
    expect(offerStopToChange(state({ steps: READING, drafts: [ARTICLE] }), allowed)).toBe(false);
  });

  it("hides on a run that has ended, and before there is a run", () => {
    expect(offerStopToChange(state({ steps: READING, error: "Setup was stopped to change what we found." }), allowed)).toBe(false);
    expect(offerStopToChange(state({ steps: READING, ready: true }), allowed)).toBe(false);
    expect(offerStopToChange(null, allowed)).toBe(false);
  });
});
