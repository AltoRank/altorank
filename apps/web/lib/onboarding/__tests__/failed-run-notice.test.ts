import { describe, it, expect } from "vitest";
import { failedRunNotice, STALE_RUN_ERROR, type OnboardingRunRow, type OnboardingRunSnapshot } from "../events";

function run(over: Partial<OnboardingRunRow> = {}): OnboardingRunRow {
  return {
    id: "run-1",
    workspace_id: "ws-1",
    status: "partial",
    phases: [],
    planned: [],
    keywords_found: null,
    article_id: null,
    error: null,
    started_at: "2026-09-09T18:37:43Z",
    updated_at: "2026-09-09T18:38:08Z",
    finished_at: "2026-09-09T18:38:08Z",
    ...over,
  } as OnboardingRunRow;
}

const snap = (r: OnboardingRunRow | null, stale = false): OnboardingRunSnapshot => ({ run: r, article: null, stale });

describe("failedRunNotice", () => {
  it("is silent when there is no run", () => {
    expect(failedRunNotice(null)).toBeNull();
    expect(failedRunNotice(snap(null))).toBeNull();
  });

  it("is silent while a run is live", () => {
    expect(failedRunNotice(snap(run({ status: "running", finished_at: null })))).toBeNull();
  });

  it("speaks up for a live run that stopped writing", () => {
    const n = failedRunNotice(snap(run({ status: "running", finished_at: null }), true));
    expect(n).toMatchObject({ runId: "run-1", tone: "error", line: STALE_RUN_ERROR });
  });

  it("speaks up for a partial run that produced nothing, in the run's own words", () => {
    // The 2026-09-09 signup: scanning done, everything after it skipped, and
    // the dashboard said nothing about why.
    const n = failedRunNotice(
      snap(
        run({
          phases: [
            { phase: "scanning", status: "done", detail: "Learned how your site writes." },
            { phase: "keywords", status: "skipped", detail: "We could not reach your site just now (timed out after 10s). The next look is already scheduled." },
            { phase: "planning", status: "skipped", detail: "Nothing to schedule until there are keywords." },
            { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
          ],
          keywords_found: 0,
        }),
      ),
    );
    expect(n?.tone).toBe("partial");
    expect(n?.line).toContain("could not reach your site");
    // The earliest reason, not the downstream one.
    expect(n?.line).not.toContain("Nothing to schedule");
  });

  it("stays quiet for a partial run that made something the person can open", () => {
    expect(failedRunNotice(snap(run({ planned: [{ term: "x", date: "2026-09-10" }] })))).toBeNull();
  });

  it("speaks up for a worker that threw", () => {
    const n = failedRunNotice(snap(run({ status: "error", error: "Onboarding could not start (500)." })));
    expect(n).toMatchObject({ tone: "error", line: "Onboarding could not start (500)." });
  });

  it("is silent for a run that finished", () => {
    expect(
      failedRunNotice({
        run: run({ status: "done", planned: [{ term: "x", date: "2026-09-10" }], article_id: "a1" }),
        article: { id: "a1", title: "T", keyword: "x", word_count: 900, fact_check_verdict: "clean", status: "review" },
        stale: false,
      }),
    ).toBeNull();
  });
});
