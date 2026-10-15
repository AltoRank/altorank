import { describe, expect, it } from "vitest";
import { bodyFraction, clock, EXPECTED_GATE_S, leadingHeadline, leadingPhase, setupFraction } from "../setup-progress";
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
