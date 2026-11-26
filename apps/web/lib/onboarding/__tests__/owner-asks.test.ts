import { beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.fn(async (): Promise<"open" | "held" | "spent"> => "held");
vi.mock("@/lib/billing/trial-hold", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/trial-hold")>("@/lib/billing/trial-hold");
  return { ...real, planHold: () => hold() };
});
vi.mock("@/lib/observability/record", () => ({ recordEvent: vi.fn(async () => undefined) }));

import { memoryDb } from "@/lib/evals/memory-db";
import { contextKey, readOpportunity } from "@/lib/keyword-research/opportunity";
import { initialOnboardingState, reduceOnboarding, stateFromRun, type OnboardingEvent, type OnboardingRunRow, type OnboardingState } from "../events";
import { acceptProposal } from "../proposal";
import { asksForCard, asksWithOffer, setupEnding } from "../setup-retry";

// A first look that could plan nothing with evidence the writer accepts ends
// by asking its owner, not by planning nothing (2026-11-16): a topic to
// confirm, or, when nothing says what the site sells, a question.

const PROPOSAL = {
  term: "garden office cost", angle: "What a garden office costs", why: "Its readers ask this before they enquire.", reader: "Homeowners", job: "Budget for a garden office",
  offering: "The design visit", shape: "explainer", volume: null, difficulty: null,
  score: { total: 49, fit: 0.75, demand: 0.5, reach: 0.6, page: 0, demandMeasured: false, pageRead: true }, checked: true, results: "Of 7 results: 7 providers' pages.", organicUrls: ["https://agency-1.example/"],
};
const PROPOSED: OnboardingEvent = { phase: "planning", status: "skipped", detail: "We have a first article to propose.", cause: "needs_owner_input", proposal: { ...PROPOSAL } };
const FACT = { hasArticle: false, writing: false, setupAllowed: true, firstAttempted: false };
const ended = (...events: OnboardingEvent[]): OnboardingState => [...events, { phase: "ready" } as OnboardingEvent].reduce(reduceOnboarding, initialOnboardingState());

describe("the endings that ask the owner", () => {
  it("keeps the proposal on the planning step, and drops it with the cause", () => {
    const state = ended(PROPOSED);
    const planning = state.steps.find((s) => s.phase === "planning")!;
    expect(planning).toMatchObject({ cause: "needs_owner_input", proposal: { term: "garden office cost", why: PROPOSAL.why } });
    const later = reduceOnboarding(state, { phase: "planning", status: "done", detail: "Scheduled." });
    expect(later.steps.find((s) => s.phase === "planning")).not.toHaveProperty("proposal");
    // A proposal with no cause, or a cause with no usable proposal, shows nothing.
    expect(ended({ ...PROPOSED, cause: undefined } as OnboardingEvent).steps.find((s) => s.phase === "planning")).not.toHaveProperty("proposal");
    expect(ended({ ...PROPOSED, proposal: { term: "" } } as unknown as OnboardingEvent).steps.find((s) => s.phase === "planning")).not.toHaveProperty("proposal");
  });

  it("reads both back off a stored run", () => {
    const run = (phases: OnboardingRunRow["phases"]): OnboardingRunRow => ({ id: "r1", workspace_id: "ws1", status: "partial", phases, planned: [], keywords_found: 0, article_id: null, error: null, empty_pool: null, started_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:03:00Z", finished_at: "2026-11-20T10:03:00Z" });
    const proposed = stateFromRun(run([{ phase: "planning", status: "skipped", cause: "needs_owner_input", proposal: { ...PROPOSAL } }]), null);
    expect(proposed.steps.find((s) => s.phase === "planning")).toMatchObject({ cause: "needs_owner_input", proposal: { term: "garden office cost" } });
    expect(setupEnding(proposed, FACT)).toBe("proposal");
    const asked = stateFromRun(run([{ phase: "planning", status: "skipped", cause: "needs_business" }]), null);
    expect(setupEnding(asked, FACT)).toBe("owner-question");
  });

  it("is a topic to confirm or a question, never a card ask or a plain retry", () => {
    expect(setupEnding(ended(PROPOSED), FACT)).toBe("proposal");
    const question = ended({ phase: "planning", status: "skipped", cause: "needs_business", detail: "Tell us what you sell." });
    expect(setupEnding(question, FACT)).toBe("owner-question");
    for (const ending of ["proposal", "owner-question"] as const) {
      expect(asksForCard(ending)).toBe(false);
      expect(asksWithOffer(ending)).toBe(false);
    }
    // An article, when there is one, is still the ending.
    expect(setupEnding(ended(PROPOSED), { ...FACT, hasArticle: true })).toBe("article");
    // The answer starts one more setup run: not offered when the gate would refuse it.
    expect(setupEnding(question, { ...FACT, setupAllowed: false })).not.toBe("owner-question");
    // The pre-trial article already attempted: the proposal cannot be written before the trial.
    expect(setupEnding(ended(PROPOSED), { ...FACT, firstAttempted: true })).not.toBe("proposal");
  });
});

describe("acceptProposal: write this", () => {
  const BUSINESS = { name: "Oakframe", description: "Oakframe designs and installs garden offices for homeowners.", conversionUrl: "https://oakframe.example/visit/" };
  const NOW = new Date();
  const seed = (over: { status?: string; phases?: unknown[]; keywords?: Record<string, unknown>[] } = {}) => memoryDb({
    workspaces: [{ id: "ws1", domain: "oakframe.example", language: "en", location_code: 2826, business_profile: BUSINESS, auto_generate_weekly_limit: 2 }],
    onboarding_runs: [{
      id: "run1", workspace_id: "ws1", account_id: "acc1", status: over.status ?? "partial", planned: [], keywords_found: 0, article_id: null, error: null, empty_pool: null,
      started_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:03:00Z", finished_at: "2026-11-20T10:03:00Z",
      phases: over.phases ?? [{ phase: "scanning", status: "done" }, { phase: "planning", status: "skipped", cause: "needs_owner_input", proposal: { ...PROPOSAL } }, { phase: "drafting", status: "skipped", detail: "Waiting for your go-ahead on the proposed topic." }],
    }],
    keywords: over.keywords ?? [],
  });
  const dispatch = vi.fn((_body: unknown) => ({ request: Promise.resolve(new Response(null, { status: 200 })) }));
  const fingerprint = contextKey({ business: BUSINESS, domain: "oakframe.example", languageCode: "en", locationCode: 2826 });

  beforeEach(() => {
    hold.mockReset().mockResolvedValue("held");
    dispatch.mockClear();
  });

  it("saves the topic with the owner's confirmation, puts it on the calendar, and has the run that proposed it write it", async () => {
    const { db, tables } = seed();
    const out = await acceptProposal(db, "ws1", { dispatch, now: NOW });
    expect(out).toEqual({ ok: true, term: "garden office cost", writing: true });
    const row = tables.keywords[0];
    expect(row).toMatchObject({ term: "garden office cost", status: "planned", workspace_id: "ws1" });
    // The brief the writer reads before an automatic draft: accepted, lower confidence, nothing cited.
    expect(readOpportunity(row.opportunity, fingerprint)).toMatchObject({ status: "qualified", confidence: "lower", rung: "owner_confirmed", evidenceUrls: [], conversionPath: "https://oakframe.example/visit/" });
    expect(tables.calendar_entries).toHaveLength(1);
    expect(tables.calendar_entries[0]).toMatchObject({ keyword_id: row.id, keyword: "garden office cost", status: "queue" });
    // The run is running again, on its own row, with the article being written.
    const run = tables.onboarding_runs[0] as { status: string; finished_at: unknown; phases: Array<Record<string, unknown>>; planned: unknown[] };
    expect(run).toMatchObject({ status: "running", finished_at: null });
    expect(run.phases.find((p) => p.phase === "planning")).toMatchObject({ status: "done" });
    expect(run.phases.find((p) => p.phase === "planning")).not.toHaveProperty("proposal");
    expect(run.phases.find((p) => p.phase === "drafting")).toMatchObject({ status: "active" });
    expect(run.planned).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1", runId: "run1", keyword: "garden office cost", keywordId: row.id }));
  });

  it("uses the keyword row the site already has, and writes nothing twice", async () => {
    const { db, tables } = seed({ keywords: [{ id: "k7", workspace_id: "ws1", term: "garden office cost", status: "stored", plan_excluded_at: "2026-11-20T10:02:00Z", opportunity: null }] });
    expect(await acceptProposal(db, "ws1", { dispatch, now: NOW })).toMatchObject({ ok: true, writing: true });
    expect(tables.keywords).toHaveLength(1);
    expect(tables.keywords[0]).toMatchObject({ id: "k7", status: "planned", plan_excluded_at: null });
    // A second click: the run is running now, so there is no proposal to accept.
    expect(await acceptProposal(db, "ws1", { dispatch, now: NOW })).toMatchObject({ ok: false });
    expect(tables.calendar_entries).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses with no open proposal, and once the trial's one article is spent", async () => {
    const none = seed({ phases: [{ phase: "planning", status: "skipped", detail: "Nothing to schedule until there are keywords." }] });
    expect(await acceptProposal(none.db, "ws1", { dispatch })).toMatchObject({ ok: false });
    const failed = seed({ status: "error" });
    expect(await acceptProposal(failed.db, "ws1", { dispatch })).toMatchObject({ ok: false });
    hold.mockResolvedValue("spent");
    const spent = seed();
    expect(await acceptProposal(spent.db, "ws1", { dispatch })).toMatchObject({ ok: false, message: expect.stringMatching(/already written/) });
    expect(spent.tables.keywords).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves it on the calendar for the nightly pass on an install that cannot start a draft from here", async () => {
    const { db, tables } = seed();
    const out = await acceptProposal(db, "ws1", { dispatch: () => ({ skipped: "no-secret" }), now: NOW });
    expect(out).toEqual({ ok: true, term: "garden office cost", writing: false });
    expect(tables.calendar_entries).toHaveLength(1);
    // Closed again, not left spinning for a draft nobody will write.
    expect((tables.onboarding_runs[0] as { status: string }).status).not.toBe("running");
  });
});
