import { describe, it, expect } from "vitest";
import {
  initialOnboardingState,
  reduceOnboarding,
  isTerminal,
  PHASE_ORDER,
  type OnboardingEvent,
  type OnboardingState,
} from "../events";

const run = (events: OnboardingEvent[]): OnboardingState =>
  events.reduce(reduceOnboarding, initialOnboardingState());

const ARTICLE = { id: "a1", title: "T", keyword: "seo agent", wordCount: 1200, verdict: "clean" as const };

describe("reduceOnboarding", () => {
  it("starts with every phase pending and nothing known", () => {
    const s = initialOnboardingState();
    expect(s.steps.map((x) => x.phase)).toEqual([...PHASE_ORDER]);
    expect(s.steps.every((x) => x.status === "pending")).toBe(true);
    expect(s).toMatchObject({ keywordsFound: null, article: null, ready: false, error: null });
  });

  /** The happy path, exactly as the pipeline emits it. */
  it("follows a full run to ready", () => {
    const s = run([
      { phase: "scanning", status: "active" },
      { phase: "scanning", status: "done" },
      { phase: "keywords", status: "active" },
      { phase: "keywords", status: "done", keywordsFound: 94 },
      { phase: "drafting", status: "active" },
      { phase: "drafting", status: "done", article: ARTICLE },
      { phase: "ready" },
    ]);
    expect(s.steps.map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(s.keywordsFound).toBe(94);
    expect(s.article).toEqual(ARTICLE);
    expect(s.ready).toBe(true);
    expect(isTerminal(s)).toBe(true);
  });

  it("treats skipped as an outcome, not an error", () => {
    const s = run([
      { phase: "drafting", status: "skipped", detail: "Your free draft is already used." },
      { phase: "ready" },
    ]);
    expect(s.steps[2]).toMatchObject({ status: "skipped", detail: "Your free draft is already used." });
    expect(s.error).toBeNull();
    expect(s.ready).toBe(true);
  });

  it("marks a step done even if its active event was lost on the wire", () => {
    const s = run([{ phase: "keywords", status: "done", keywordsFound: 3 }]);
    expect(s.steps[1].status).toBe("done");
    expect(s.keywordsFound).toBe(3);
  });

  it("is idempotent for a duplicated event", () => {
    const once = run([{ phase: "scanning", status: "done" }]);
    const twice = run([{ phase: "scanning", status: "done" }, { phase: "scanning", status: "done" }]);
    expect(twice).toEqual(once);
  });

  it("keeps a detail when a later event for the same phase carries none", () => {
    const s = run([
      { phase: "scanning", status: "failed", detail: "ENOTFOUND" },
      { phase: "scanning", status: "failed" },
    ]);
    expect(s.steps[0].detail).toBe("ENOTFOUND");
  });

  it("records an error as terminal without touching the steps", () => {
    const s = run([{ phase: "scanning", status: "active" }, { phase: "error", detail: "boom" }]);
    expect(s.error).toBe("boom");
    expect(s.steps[0].status).toBe("active");
    expect(isTerminal(s)).toBe(true);
  });

  it("does not mutate the previous state", () => {
    const before = initialOnboardingState();
    const frozen = JSON.stringify(before);
    reduceOnboarding(before, { phase: "keywords", status: "done", keywordsFound: 1 });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
