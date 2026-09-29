import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The card form itself is tested with billing; here it is a marker, so the
// question is only whether the ask is rendered at all.
vi.mock("@/components/billing/trial-offer", () => ({ TrialOffer: () => <div data-testid="trial-offer">Start 7-day trial</div> }));

import { SetupAsk, NOTHING_PLANNED_HEADING, nothingPlannedLede } from "../setup-ask";
import { asksForCard, setupEnding } from "@/lib/onboarding/setup-retry";
import { reduceOnboarding, initialOnboardingState, stateFromRun, type EmptyPool, type OnboardingEvent, type OnboardingRunRow } from "@/lib/onboarding/events";

// renderToStaticMarkup, as the editor panels are tested: no jsdom in this repo.
const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const POOL: EmptyPool = {
  stage: "qualification",
  cause: "buyer_mismatch",
  keywords: 144,
  qualified: 0,
  rejected: { buyer_mismatch: 117 },
  pending: { unjudged: 27 },
  summary: "None of 144 searches qualified.",
};

/** A first look that ran every phase and planned nothing, as the row stores it. */
const nothingPlannedRow: OnboardingRunRow = {
  id: "r1",
  workspace_id: "ws1",
  status: "nothing_planned",
  phases: [
    { phase: "scanning", status: "done", detail: "Learned how your site writes." },
    { phase: "keywords", status: "done", detail: "34 keywords found." },
    { phase: "pages", status: "done", detail: "Checked 12 pages." },
    { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
    { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
  ],
  planned: [],
  keywords_found: 144,
  article_id: null,
  error: null,
  empty_pool: POOL,
  started_at: "2026-09-28T10:00:00.000Z",
  updated_at: "2026-09-28T10:05:00.000Z",
  finished_at: "2026-09-28T10:05:00.000Z",
};

const GATED = { hasArticle: false, writing: false, setupAllowed: true, firstAttempted: false };

describe("setupEnding: the one decision both setup screens read", () => {
  it("a run that planned nothing never asks for a card - even with setup allowed again", () => {
    const ending = setupEnding(stateFromRun(nothingPlannedRow, null), GATED);
    expect(ending).toBe("nothing-planned");
    expect(asksForCard(ending)).toBe(false);
  });

  it("the live run screen reaches the same answer from the events", () => {
    const events: OnboardingEvent[] = [
      ...nothingPlannedRow.phases.map((p) => ({ ...p, status: p.status as Exclude<typeof p.status, "pending">, ...(p.phase === "planning" ? { emptyPool: POOL, planned: [] } : {}) })),
      { phase: "ready" },
    ];
    const live = events.reduce(reduceOnboarding, initialOnboardingState());
    expect(setupEnding(live, GATED)).toBe("nothing-planned");
  });

  it("a run that fell short still offers the retry, and every other ending still asks for the card", () => {
    const fellShort = stateFromRun({ ...nothingPlannedRow, status: "partial", empty_pool: null, phases: [{ phase: "keywords", status: "failed", detail: "provider down" }] }, null);
    expect(setupEnding(fellShort, GATED)).toBe("retry");
    expect(setupEnding(stateFromRun(nothingPlannedRow, null), { ...GATED, hasArticle: true })).toBe("article");
    expect(setupEnding(stateFromRun(nothingPlannedRow, null), { ...GATED, writing: true })).toBe("writing");
    expect(setupEnding(null, { ...GATED, setupAllowed: false, firstAttempted: true })).toBe("first-failed");
    for (const ending of ["article", "writing", "retry", "first-failed", "no-article"] as const) expect(asksForCard(ending)).toBe(true);
  });
});

describe("SetupAsk", () => {
  it("renders the honest note, and no card ask, for a run that planned nothing", () => {
    const ending = setupEnding(stateFromRun(nothingPlannedRow, null), GATED);
    const html = text(renderToStaticMarkup(<SetupAsk ending={ending} canBuy />));
    expect(html).not.toContain("trial-offer");
    expect(html).not.toMatch(/trial/i);
    expect(html).toContain("writes to you within 24 hours");
    expect(html).toContain("nothing to pay");
  });

  it("renders the card ask otherwise", () => {
    expect(renderToStaticMarkup(<SetupAsk ending="article" canBuy />)).toContain("trial-offer");
    expect(renderToStaticMarkup(<SetupAsk ending="no-article" canBuy />)).toContain("trial-offer");
  });

  it("the heading and lede say nothing cleared the bar, that the team knows, and when they will hear back", () => {
    expect(NOTHING_PLANNED_HEADING).toBe("Nothing cleared the bar for a first article yet");
    const lede = nothingPlannedLede("acme-clinic.example", POOL);
    expect(lede).toContain("checked 144 searches");
    expect(lede).toContain("Our team has been told");
    expect(lede).toContain("by email within 24 hours");
    expect(lede).not.toMatch(/trial|card/i);
    expect(nothingPlannedLede("", null)).toContain("We read your site and did not find a search");
  });
});
