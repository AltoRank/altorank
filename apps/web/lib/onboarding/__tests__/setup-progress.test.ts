import { describe, expect, it } from "vitest";
import {
  bodyFraction, clock, estimateLine, EXPECTED_BODY_S, EXPECTED_GATE_S, FIRST_LOOK_MINUTES, firstLookFraction, leadingHeadline, leadingPhase,
  LONGER_AFTER_S, runningLong, SETUP_SHARE, setupFraction,
} from "../setup-progress";
import { PHASE_ORDER, type OnboardingStep, type PhaseStatus } from "../events";

const steps = (statuses: Partial<Record<string, PhaseStatus>>): OnboardingStep[] =>
  PHASE_ORDER.map((phase) => ({ phase, status: statuses[phase] ?? "pending" }));

describe("the setup bar", () => {
  it("walks with the clock while the phases running have room", () => {
    const s = steps({ scanning: "active", keywords: "active" });
    expect(setupFraction(s, 10)).toBeCloseTo(10 / EXPECTED_GATE_S, 3);
    expect(setupFraction(s, 20)).toBeGreaterThan(setupFraction(s, 10));
  });

  it("is never behind a finished phase and never past a running one", () => {
    // Planning finished early: the bar is at least where planning ends.
    const fast = steps({ scanning: "done", keywords: "done", pages: "done", planning: "done", drafting: "active" });
    expect(setupFraction(fast, 30)).toBeGreaterThanOrEqual(80 / EXPECTED_GATE_S);
    // Keywords running long: the bar slows under where keywords end, and keeps moving.
    const slow = steps({ scanning: "done", keywords: "active", pages: "done" });
    const at60 = setupFraction(slow, 60);
    const at120 = setupFraction(slow, 120);
    expect(at60).toBeLessThan(45 / EXPECTED_GATE_S);
    expect(at120).toBeGreaterThan(at60);
    expect(at120).toBeLessThan(45 / EXPECTED_GATE_S);
  });

  it("is monotonic in time and reaches 1 only when every phase has settled", () => {
    const s = steps({ scanning: "done", keywords: "done", pages: "done", planning: "done", drafting: "active" });
    let last = 0;
    for (let t = 0; t < 600; t += 3) {
      const f = setupFraction(s, t);
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeLessThan(1);
      last = f;
    }
    expect(setupFraction(steps({ scanning: "done", keywords: "done", pages: "skipped", planning: "done", drafting: "done" }), 5)).toBe(1);
  });

  it("leads with the earliest phase still running, never the background page check", () => {
    expect(leadingPhase(steps({ scanning: "active", keywords: "active" }))).toBe("scanning");
    expect(leadingPhase(steps({ scanning: "done", keywords: "done", pages: "active" }))).toBe("planning");
    expect(leadingPhase(steps({ scanning: "done", keywords: "done", pages: "done", planning: "done", drafting: "done" }))).toBeNull();
    expect(leadingHeadline("planning", "acme.example")).toBe("Checking which topics you can win");
    expect(leadingHeadline("scanning", "acme.example")).toBe("Reading acme.example");
  });
});

describe("the body bar", () => {
  it("moves through thinking, writing and finishing, and is 1 only when done", () => {
    const thinking = bodyFraction("thinking", 20, false);
    const writing = bodyFraction("writing", 5, false);
    const finishing = bodyFraction("finishing", 5, false);
    expect(thinking).toBeGreaterThan(0);
    expect(writing).toBeGreaterThan(thinking);
    expect(finishing).toBeGreaterThan(writing);
    expect(bodyFraction("thinking", 600, false)).toBeLessThan(bodyFraction("writing", 0, false) + 0.001);
    expect(bodyFraction("finishing", 600, false)).toBeLessThan(1);
    expect(bodyFraction("writing", 0, true)).toBe(1);
  });

  it("prints the elapsed time as minutes and seconds", () => {
    expect(clock(47.9)).toBe("0:47");
    expect(clock(125)).toBe("2:05");
  });
});

describe("one bar and one clock, from the click to the written article", () => {
  const all = (status: PhaseStatus) => steps({ scanning: status, keywords: status, pages: status, planning: status, drafting: status });

  it("gives the setup its share of the bar and the body the rest, with no jump back at the gate", () => {
    expect(SETUP_SHARE).toBeCloseTo(EXPECTED_GATE_S / (EXPECTED_GATE_S + EXPECTED_BODY_S), 6);
    const endOfLoading = firstLookFraction(steps({ scanning: "done", keywords: "done", pages: "done", planning: "done", drafting: "active" }), 200);
    const startOfGate = firstLookFraction(all("done"), 0, { stage: null, stageElapsedS: 0, done: false });
    // The loading screen never fills more than the setup's share...
    expect(endOfLoading).toBeLessThanOrEqual(SETUP_SHARE);
    // ...and the gate picks up where it stopped, never behind it.
    expect(startOfGate).toBeGreaterThanOrEqual(endOfLoading);
    expect(startOfGate - endOfLoading).toBeLessThan(0.05);
  });

  it("moves forward through the body and reaches 1 only when the article is written", () => {
    let last = 0;
    for (const [stage, t] of [["thinking", 0], ["thinking", 30], ["writing", 0], ["writing", 30], ["finishing", 10], ["finishing", 600]] as const) {
      const f = firstLookFraction([], 0, { stage, stageElapsedS: t, done: false });
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeLessThan(1);
      last = f;
    }
    expect(firstLookFraction([], 0, { stage: "finishing", stageElapsedS: 0, done: true })).toBe(1);
  });

  it("promises about three minutes once, and says when it is taking longer", () => {
    expect(FIRST_LOOK_MINUTES).toBe(3);
    expect(estimateLine(60, false)).toBe("about 3 minutes in all");
    expect(estimateLine(170, true)).toBe("about 3 minutes in all");
    expect(estimateLine(LONGER_AFTER_S + 1, true)).toBe("Taking longer than usual");
    // Setup alone a minute past its usual end: the article cannot land in three minutes.
    expect(runningLong(EXPECTED_GATE_S + 61, false)).toBe(true);
    expect(runningLong(EXPECTED_GATE_S + 61, true)).toBe(false);
  });
});
