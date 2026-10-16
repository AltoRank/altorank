import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEDULED_REWRITES_NEED_PLAN } from "@/lib/billing/quota";

// ---------------------------------------------------------------------------
// The Improvements copy says only what the code does
// ---------------------------------------------------------------------------
//
// The weekly pass is cron/refresh, which visits only sites with scheduled
// rewrites on (off by default) and a plan. The page promised it to every
// Search Console site. The plan message promised briefs to accounts that
// generateBrief refuses once their free drafts are spent.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/refresh", () => ({
  analyzeNow: vi.fn(),
  cancelTask: vi.fn(),
  dismissCandidate: vi.fn(),
  generateBrief: vi.fn(),
  saveBrief: vi.fn(),
  scheduleCandidate: vi.fn(),
}));

const { ImprovementsView } = await import("../improvements-view");

const view = (enabled: boolean) =>
  renderToStaticMarkup(
    <ImprovementsView
      workspaceId="ws1"
      gscConnected
      cms={{ connected: true, labels: ["WordPress"], updatable: true }}
      refresh={{ enabled, days: enabled ? [2] : [], lastAnalyzedAt: null }}
      candidates={[]}
      executions={[]}
      tech={{ pages: [], pagesChecked: 0, checkedAt: null }}
    />,
  );

describe("Improvements copy", () => {
  it("does not promise a weekly pass with scheduled rewrites off", () => {
    const html = view(false);
    expect(html).not.toMatch(/the weekly pass does the same/);
    expect(html).toMatch(/nothing re-reads them on its own/);
    expect(html).not.toMatch(/Candidates can be found and scheduled/);
  });

  it("names the condition the weekly pass runs under", () => {
    expect(view(true)).toMatch(/while scheduled rewrites run on this site, a weekly pass does the same/);
  });

  it("the plan message does not promise generated briefs without a plan", () => {
    expect(SCHEDULED_REWRITES_NEED_PLAN).not.toMatch(/briefs .* stay available/);
    expect(SCHEDULED_REWRITES_NEED_PLAN).toMatch(/write a brief by hand/);
    expect(SCHEDULED_REWRITES_NEED_PLAN).toMatch(/needs free drafts left or a plan/);
  });
});
