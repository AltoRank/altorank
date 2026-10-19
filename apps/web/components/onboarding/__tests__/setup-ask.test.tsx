import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The card form itself is tested with billing; here it is a marker, so the
// question is only whether the ask is rendered at all.
const priceBox = vi.hoisted(() => ({ onSeen: undefined as undefined | (() => void) }));
vi.mock("@/components/billing/trial-offer", () => ({
  TrialOffer: () => <div data-testid="trial-offer">Start 7-day trial</div>,
  TrialPriceBox: ({ onSeen }: { onSeen?: () => void }) => {
    priceBox.onSeen = onSeen;
    return <div data-testid="trial-offer">Start 7-day trial</div>;
  },
}));
// The step a branch records, as a marker: effects do not run in static markup.
vi.mock("../track-step", () => ({
  TrackStep: ({ step, workspaceId, props }: { step: string; workspaceId?: string; props?: object }) => <i data-step={step} data-ws={workspaceId} data-props={JSON.stringify(props ?? {})} />,
}));
const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding/track-step", () => ({ trackStep: (...a: unknown[]) => track(...a) }));

import { SetupAsk, NOTHING_PLANNED_HEADING, nothingPlannedLede } from "../setup-ask";
import { asksForCard, asksWithOffer, setupEnding } from "@/lib/onboarding/setup-retry";
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

  it("a run that fell short offers the retry and no card; every other ending still asks for the card", () => {
    const fellShort = stateFromRun({ ...nothingPlannedRow, status: "partial", empty_pool: null, phases: [{ phase: "keywords", status: "failed", detail: "provider down" }] }, null);
    expect(setupEnding(fellShort, GATED)).toBe("retry");
    expect(setupEnding(stateFromRun(nothingPlannedRow, null), { ...GATED, hasArticle: true })).toBe("article");
    expect(setupEnding(stateFromRun(nothingPlannedRow, null), { ...GATED, writing: true })).toBe("writing");
    expect(setupEnding(null, { ...GATED, setupAllowed: false, firstAttempted: true })).toBe("first-failed");
    expect(asksForCard("retry")).toBe(false);
    for (const ending of ["article", "writing", "first-failed", "no-article"] as const) expect(asksForCard(ending)).toBe(true);
  });
});

describe("SetupAsk", () => {
  it("renders the honest note, and no card ask, for a run that planned nothing", () => {
    const ending = setupEnding(stateFromRun(nothingPlannedRow, null), GATED);
    const html = text(renderToStaticMarkup(<SetupAsk ending={ending} canBuy followUp />));
    expect(html).not.toContain("trial-offer");
    expect(html).not.toMatch(/trial/i);
    expect(html).toContain("writes to you within 24 hours");
    expect(html).toContain("nothing to pay");
  });

  it("promises no reply when nobody would be told (no operator address)", () => {
    const html = text(renderToStaticMarkup(<SetupAsk ending="nothing-planned" canBuy followUp={false} />));
    expect(html).not.toContain("trial-offer");
    expect(html).not.toMatch(/24 hours|writes to you|our team/i);
    expect(html).toContain("nothing to pay");
  });

  it("asks for no card beside a retry, and says nothing was charged", () => {
    const html = text(renderToStaticMarkup(<SetupAsk ending="retry" canBuy followUp />));
    expect(html).not.toContain("trial-offer");
    expect(html).not.toMatch(/trial|€/i);
    expect(html).toContain("Nothing has been charged");
  });

  it("renders the card ask beside an article", () => {
    expect(renderToStaticMarkup(<SetupAsk ending="article" canBuy followUp />)).toContain("trial-offer");
  });

  it("with no article, says nothing was charged and keeps the trial to one quiet button", () => {
    for (const ending of ["first-failed", "no-article"] as const) {
      const markup = renderToStaticMarkup(<SetupAsk ending={ending} canBuy followUp />);
      expect(markup).toContain("quiet-trial-ask");
      expect(markup).not.toContain("trial-offer");
      expect(text(markup)).toContain("Nothing has been charged.");
      // The price is said before the click, not first in the checkout sheet.
      expect(text(markup)).toMatch(/7 days free, then €\d+\/month\./);
      // Nothing was written on no-article, so nothing is written "again".
      expect(text(markup)).not.toMatch(/written again/);
      expect(markup).not.toContain("bg-accent");
      expect(asksWithOffer(ending)).toBe(false);
    }
    expect(asksWithOffer("article")).toBe(true);
    expect(asksWithOffer("writing")).toBe(true);
  });

  it("the heading and lede say nothing cleared the bar, that the team knows, and when they will hear back", () => {
    expect(NOTHING_PLANNED_HEADING).toBe("We did not find a clear first topic yet");
    const lede = nothingPlannedLede("acme-clinic.example", POOL, true);
    // The 117 a judge decided, not the 27 it never reached.
    expect(lede).toContain("checked 117 searches");
    expect(lede).toContain("Our team has been told");
    expect(lede).toContain("by email within 24 hours");
    expect(lede).not.toMatch(/trial|card/i);
    expect(nothingPlannedLede("", null, true)).toContain("We read your site and did not find a search");
  });

  it("the lede makes no promise when nobody would be told", () => {
    const lede = nothingPlannedLede("acme-clinic.example", POOL, false);
    expect(lede).toContain("checked 117 searches");
    expect(lede).not.toMatch(/24 hours|our team|hear back/i);
  });
});

describe("SetupAsk says which ending was on screen (onboarding.step)", () => {
  const stepsIn = (html: string) => [...html.matchAll(/data-step="([^"]+)"(?: data-ws="([^"]*)")? data-props="([^"]*)"/g)].map((m) => ({ step: m[1], ws: m[2], props: JSON.parse(m[3].replace(/&quot;/g, '"')) }));

  it("on every branch, with the ending, for the site it ran for", () => {
    for (const ending of ["article", "writing", "retry", "first-failed", "no-article", "nothing-planned", "provider-down"] as const) {
      const steps = stepsIn(renderToStaticMarkup(<SetupAsk ending={ending} canBuy followUp workspaceId="ws1" />));
      expect(steps.filter((s) => s.step === "setup_ending_shown")).toEqual([{ step: "setup_ending_shown", ws: "ws1", props: { ending } }]);
      // The card ask is still only where a card is asked for.
      expect(steps.some((s) => s.step === "gate_shown")).toBe(asksForCard(ending));
    }
  });

  it("says the offer was seen only when the price box says it was on screen, with the viewport bucket", () => {
    track.mockClear();
    priceBox.onSeen = undefined;
    const offer = { interval: "month" as const, onInterval: () => undefined, facts: { trialEndsOn: "2026-10-26", vatAdded: false } as never, fullArticle: true };
    renderToStaticMarkup(<SetupAsk ending="article" canBuy followUp offer={offer} workspaceId="ws1" />);
    expect(track).not.toHaveBeenCalledWith("offer_seen", expect.anything());
    vi.stubGlobal("window", { innerWidth: 800 });
    try {
      priceBox.onSeen?.();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(track).toHaveBeenCalledWith("offer_seen", { workspaceId: "ws1", props: { viewport: "tablet" } });
  });
});
