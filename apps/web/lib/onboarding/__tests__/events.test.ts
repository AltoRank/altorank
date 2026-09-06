import { describe, it, expect } from "vitest";
import {
  initialOnboardingState,
  reduceOnboarding,
  isTerminal,
  onboardingOutcome,
  phaseLabel,
  PHASE_LABELS,
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
      { phase: "planning", status: "active" },
      { phase: "planning", status: "done", planned: [{ term: "seo agent", date: "2026-09-04" }] },
      { phase: "drafting", status: "active" },
      { phase: "drafting", status: "done", article: ARTICLE },
      { phase: "ready" },
    ]);
    expect(s.steps.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(s.planned).toEqual([{ term: "seo agent", date: "2026-09-04" }]);
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
    expect(s.steps[3]).toMatchObject({ status: "skipped", detail: "Your free draft is already used." });
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

  /** A mid-phase progress note replaces the detail and leaves the status alone. */
  it("updates detail on a repeated active event without leaving active", () => {
    const s = run([
      { phase: "drafting", status: "active" },
      { phase: "drafting", status: "active", detail: "Writing now." },
    ]);
    expect(s.steps[3]).toEqual({ phase: "drafting", status: "active", detail: "Writing now." });
    expect(isTerminal(s)).toBe(false);
  });

  it("does not mutate the previous state", () => {
    const before = initialOnboardingState();
    const frozen = JSON.stringify(before);
    reduceOnboarding(before, { phase: "keywords", status: "done", keywordsFound: 1 });
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------
// P0-O1: a label must not claim an outcome the run did not reach
// ---------------------------------------------------------------------------

describe("phaseLabel", () => {
  it("has a distinct label for every status of every phase", () => {
    for (const phase of PHASE_ORDER) {
      const labels = PHASE_LABELS[phase];
      expect(new Set([labels.active, labels.done, labels.skipped, labels.failed]).size).toBe(4);
    }
  });

  it("does not print the done label for a skipped or failed phase", () => {
    for (const phase of PHASE_ORDER) {
      const done = PHASE_LABELS[phase].done;
      expect(phaseLabel({ phase, status: "skipped" })).not.toBe(done);
      expect(phaseLabel({ phase, status: "failed" })).not.toBe(done);
    }
  });

  it("reads the exact three regressions the audit found", () => {
    // Each of these used to render the past-tense success line over its own
    // refusal reason.
    expect(phaseLabel({ phase: "planning", status: "skipped" })).not.toMatch(/Scheduled/);
    expect(phaseLabel({ phase: "drafting", status: "skipped" })).not.toMatch(/Wrote/);
    expect(phaseLabel({ phase: "keywords", status: "skipped" })).not.toMatch(/Found/);
  });

  it("keeps the present participle while a phase is running", () => {
    expect(phaseLabel({ phase: "scanning", status: "active" })).toBe("Reading your site");
  });

  it("uses the infinitive, not a past tense, for a phase that has not started", () => {
    expect(phaseLabel({ phase: "drafting", status: "pending" })).toBe("Write your first draft");
  });
});

// ---------------------------------------------------------------------------
// P0-O2: the closing sentence is derived from the run, not from `ready`
// ---------------------------------------------------------------------------

describe("onboardingOutcome", () => {
  const ready = (events: OnboardingEvent[]) => onboardingOutcome(run([...events, { phase: "ready" }]));

  it("reports work still in flight without claiming anything", () => {
    const o = onboardingOutcome(run([{ phase: "scanning", status: "active" }]));
    expect(o.tone).toBe("working");
    expect(o.produced).toBe(false);
  });

  it("passes an error through verbatim", () => {
    const o = onboardingOutcome(run([{ phase: "error", detail: "Lost the connection while setting up." }]));
    expect(o).toEqual({ tone: "error", line: "Lost the connection while setting up.", produced: false });
  });

  it("claims the calendar and the draft only when both happened", () => {
    const o = ready([
      { phase: "planning", status: "done", planned: [{ term: "a", date: "2026-09-07" }, { term: "b", date: "2026-09-08" }] },
      { phase: "drafting", status: "done", article: ARTICLE },
    ]);
    expect(o.tone).toBe("done");
    expect(o.line).toBe("Done. 2 articles on the calendar and your first draft is in review.");
    expect(o.produced).toBe(true);
  });

  it("does not say the first month is on the calendar when nothing was scheduled", () => {
    const o = ready([
      { phase: "keywords", status: "skipped", detail: "Nothing rankable found for this site yet." },
      { phase: "planning", status: "skipped", detail: "Nothing to schedule until there are keywords." },
      { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
    ]);
    expect(o.tone).toBe("partial");
    expect(o.line).toBe("Set up, but nothing could be scheduled yet: nothing rankable found for this site yet.");
    expect(o.produced).toBe(false);
  });

  it("names the earliest reason, not the last one", () => {
    const o = ready([
      { phase: "scanning", status: "failed", detail: "ENOTFOUND example.com" },
      { phase: "planning", status: "skipped", detail: "Nothing to schedule until there are keywords." },
    ]);
    expect(o.line).toContain("ENOTFOUND example.com");
  });

  it("reports a plan with no draft, and why there is no draft", () => {
    const o = ready([
      { phase: "planning", status: "done", planned: [{ term: "a", date: "2026-09-07" }] },
      { phase: "drafting", status: "skipped", detail: "This month's 7 free drafts are used. Choose a plan to keep drafting." },
    ]);
    expect(o.line).toBe(
      "1 article on the calendar. No draft yet: this month's 7 free drafts are used. Choose a plan to keep drafting.",
    );
    expect(o.produced).toBe(true);
  });

  it("reports a draft with no plan", () => {
    const o = ready([
      { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
      { phase: "drafting", status: "done", article: ARTICLE },
    ]);
    expect(o.line).toBe("Your first draft is in review. Nothing else could be scheduled yet: no keyword clear enough to plan yet.");
    expect(o.produced).toBe(true);
  });

  it("falls back to a bare sentence when no phase gave a reason", () => {
    const o = ready([{ phase: "planning", status: "skipped" }]);
    expect(o.line).toBe("Set up, but nothing could be scheduled yet.");
  });

  it("adds the hand-off clause only on the happy path", () => {
    const full = run([
      { phase: "planning", status: "done", planned: [{ term: "a", date: "2026-09-07" }] },
      { phase: "drafting", status: "done", article: ARTICLE },
      { phase: "ready" },
    ]);
    expect(onboardingOutcome(full, true).line).toMatch(/Taking you there\.$/);
    const empty = run([{ phase: "ready" }]);
    expect(onboardingOutcome(empty, true).line).not.toMatch(/Taking you there/);
  });
});
