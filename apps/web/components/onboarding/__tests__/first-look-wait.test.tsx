import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The wait, as markup: what the loading screen shows instead of a skeleton,
// and the one clock carried into the gate's card (UX audit 2026-10-12, #7).

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/actions/first-look-exits", () => ({ emailWhenReady: async () => ({ ok: true, email: "owner@acme-shop.example" }), emailFirstArticle: async () => ({ ok: true, email: "owner@acme-shop.example" }) }));

import { SetupLoading, waitingFacts } from "../setup-loading";
import { FirstArticleCardView, offersLeave } from "../first-article-card";
import { LONGER_AFTER_S, runningLong } from "@/lib/onboarding/setup-progress";
import { initialOnboardingState, type OnboardingState } from "@/lib/onboarding/events";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const REPORT = {
  auditedAt: "2026-10-12T00:00:00Z",
  pagesCrawled: 40,
  onPageScore: 80,
  readiness: { score: 96, partial: false, error: null, findings: [{ check: "sitemap", passed: false, severity: "high", detail: "", inconclusive: false }] },
  speed: null,
  page: null,
  issues: [],
  existingPages: { checked: 40, withIssues: 25, worst: [] },
} as FirstLookReport;

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({ ...initialOnboardingState(), ...over });

describe("the loading screen's centre", () => {
  it("shows what the first look has found, in plain words, with no score", () => {
    const facts = waitingFacts(state({ keywordsFound: 81 }), REPORT);
    expect(facts).toEqual(["40 pages of your site read", "81 searches your customers make", "25 existing pages with something to fix"]);
    expect(facts.join(" ")).not.toMatch(/\/100|readability/);
    expect(waitingFacts(state(), null)).toEqual([]);
  });

  it("names the chosen topic once planning has settled, and promises about three minutes in all", () => {
    const planned = state({
      planned: [{ term: "acme kits", date: "2026-10-12" }],
      steps: initialOnboardingState().steps.map((s) => (s.phase === "drafting" ? { ...s, status: "active" as const } : { ...s, status: "done" as const })),
    });
    const html = text(renderToStaticMarkup(<SetupLoading workspaceId="ws1" domain="acme-shop.example" state={planned} report={REPORT} startedAt={null} log={null} />));
    expect(html).toContain("On “acme kits”");
    expect(html).toContain("about 3 minutes in all");
    expect(html).not.toMatch(/usually about 1:32/);
  });

  it("says when it lost the server for a moment, without ending anything", () => {
    const html = text(renderToStaticMarkup(<SetupLoading workspaceId="ws1" domain="acme-shop.example" state={state()} report={null} startedAt={null} log={null} reconnecting />));
    expect(html).toContain("Reconnecting");
    expect(html).not.toMatch(/did not finish|lost contact/i);
  });
});

describe("the gate's card while the body is written", () => {
  const OUTLINED: FirstArticleCard = {
    id: "a1", title: "Acme kits", keyword: "acme kits", scheduledDate: null, outline: ["One", "Two"], wordCount: 1500, sources: 0, verdict: null, more: 0, labels: [], state: "outlined",
  };
  const live = { html: "", done: false, stage: "writing" as const, stageSince: null, sectionsDone: [], words: 0, arrivalCps: 0, refused: false };

  it("says it stopped watching when the server refused, and how to get back, without saying the run ended", () => {
    const signedOut = text(renderToStaticMarkup(<SetupLoading workspaceId="ws1" domain="acme-shop.example" state={state()} report={null} startedAt={null} log={null} reconnecting refused="signed-out" />));
    expect(signedOut).toContain("You were signed out, so this screen stopped following setup. Setup carries on without it.");
    expect(signedOut).toContain("Sign in again");
    expect(signedOut).not.toContain("Reconnecting");
    expect(signedOut).not.toMatch(/did not finish/);
    const gone = text(renderToStaticMarkup(<SetupLoading workspaceId="ws1" domain="acme-shop.example" state={state()} report={null} startedAt={null} log={null} refused="no-access" />));
    expect(gone).toContain("can no longer see this site's setup");
  });

  it("offers leaving the page only while there is nothing to read yet, and not before 4:30", () => {
    expect(offersLeave(true, false)).toBe(true);
    expect(offersLeave(true, true)).toBe(false);
    expect(offersLeave(false, false)).toBe(false);
    // The recorded normal run finished at 3:29; it is not "taking longer".
    expect(runningLong(209, true)).toBe(false);
    expect(runningLong(LONGER_AFTER_S + 1, true)).toBe(true);
  });

  it("carries the one bar on from the setup's share and drops the second estimate", () => {
    const markup = renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live} startedAt={Date.now() - 100_000} workspaceId="ws1" />);
    expect(markup).not.toMatch(/usually about 2 minutes/);
    const now = Number(markup.match(/aria-valuenow="(\d+)"/)?.[1]);
    // Past the setup's share of the bar, not back at the start.
    expect(now).toBeGreaterThanOrEqual(45);
  });
});
