import { describe, expect, it } from "vitest";
import { initialOnboardingState, onboardingOutcome, PLANNING_CHECK_TERMS, reduceOnboarding, stateFromRun, type OnboardingRunRow } from "../events";
import { withoutChecking } from "../run-store";

// The searches the planner is checking, named on the loading screen while it
// checks them, and gone from the row the moment planning settles: a finished
// run's row is readable by every member, and the topics the plan held for
// the trial are what the trial sells.

const terms = Array.from({ length: 15 }, (_, i) => `acme term ${i}`);

describe("the planning check", () => {
  it("rides on the active step, a handful of terms at most", () => {
    const s = reduceOnboarding(initialOnboardingState(), { phase: "planning", status: "active", checking: { terms, judged: 0, qualified: 0 } });
    const step = s.steps.find((x) => x.phase === "planning");
    expect(step?.checking?.terms).toHaveLength(PLANNING_CHECK_TERMS);
    // A later count without terms keeps the step active and replaces the check.
    const next = reduceOnboarding(s, { phase: "planning", status: "active", checking: { terms: [], judged: 15, qualified: 3 } });
    expect(next.steps.find((x) => x.phase === "planning")?.checking).toEqual({ terms: [], judged: 15, qualified: 3 });
  });

  it("is dropped when planning settles, and never read back off a settled row", () => {
    let s = reduceOnboarding(initialOnboardingState(), { phase: "planning", status: "active", checking: { terms, judged: 0, qualified: 0 } });
    s = reduceOnboarding(s, { phase: "planning", status: "done", detail: "Scheduled your first article." });
    const settled = s.steps.find((x) => x.phase === "planning");
    expect(settled).not.toHaveProperty("checking");
    expect(JSON.stringify(s.steps)).not.toContain("acme term");

    // A row written by older code, or by hand, with terms on a settled step.
    const row = {
      id: "r1", workspace_id: "ws1", status: "running", planned: [], keywords_found: 10, article_id: null, error: null,
      started_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:01:00Z", finished_at: null,
      phases: [
        { phase: "planning", status: "done", checking: { terms, judged: 3, qualified: 1 } },
        { phase: "drafting", status: "active", checking: { terms, judged: 3, qualified: 1 } },
      ],
    } as unknown as OnboardingRunRow;
    const read = stateFromRun(row, null);
    expect(read.steps.find((x) => x.phase === "planning")).not.toHaveProperty("checking");
  });

  it("is not read back off a run that was closed mid-planning, and closing it drops the terms", () => {
    const row = {
      id: "r1", workspace_id: "ws1", status: "error", planned: [], keywords_found: 10, article_id: null, error: "cut off",
      started_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:01:00Z", finished_at: "2026-10-12T00:02:00Z",
      phases: [
        { phase: "keywords", status: "done", detail: "10 keywords" },
        { phase: "planning", status: "active", checking: { terms, judged: 3, qualified: 1 } },
      ],
    } as unknown as OnboardingRunRow;
    expect(JSON.stringify(stateFromRun(row, null).steps)).not.toContain("acme term");
    // Still running, the same step does carry them.
    expect(stateFromRun({ ...row, status: "running" }, null).steps.find((x) => x.phase === "planning")?.checking?.terms.length).toBe(PLANNING_CHECK_TERMS);
    const closed = withoutChecking(row.phases);
    expect(JSON.stringify(closed)).not.toContain("acme term");
    expect(closed?.find((p) => p.phase === "planning")).toEqual({ phase: "planning", status: "active" });
    expect(closed?.find((p) => p.phase === "keywords")).toEqual({ phase: "keywords", status: "done", detail: "10 keywords" });
    expect(withoutChecking([{ phase: "keywords", status: "done" }] as OnboardingRunRow["phases"])).toBeNull();
  });

  it("says outlined, not written, while the first article's body is still owed", () => {
    let s = reduceOnboarding(initialOnboardingState(), { phase: "planning", status: "done", planned: [{ term: "acme kits", date: "2026-10-12" }] });
    s = reduceOnboarding(s, { phase: "drafting", status: "done", article: { id: "a1", title: "T", keyword: "acme kits", wordCount: 1300, verdict: "unchecked", outlined: true } });
    s = reduceOnboarding(s, { phase: "ready" });
    expect(onboardingOutcome(s, false, { preTrial: true }).line).toBe("Done. 1 article on the calendar and your first article is outlined and being written.");
  });
});
