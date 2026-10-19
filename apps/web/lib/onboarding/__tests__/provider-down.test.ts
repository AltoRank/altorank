import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/record", () => ({ recordEvent: vi.fn(async () => undefined) }));
vi.mock("../run-dispatch", () => ({ dispatchWorker: vi.fn(async () => undefined) }));
const recordRunStarted = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true));
vi.mock("../step-events", () => ({ recordRunStarted: (...a: unknown[]) => recordRunStarted(...a) }));

import { initialOnboardingState, providerDown, reduceOnboarding, stateFromRun, type OnboardingRunRow } from "../events";
import { asksForCard, setupEnding } from "../setup-retry";
import { retryProviderDownRuns, PROVIDER_RETRY_AFTER_MS, PROVIDER_RETRY_WITHIN_MS } from "../provider-retry";
import { providerRetryWindowOpen } from "../provider-retry-window";
import { setupFailedFacts } from "../run-store";
import { renderSetupFailed } from "@/lib/email/lifecycle";

// A provider outage gets its own honest ending (UX audit 2026-10-12, #16):
// ours, not the site's, no paid retry button, no card, and an overnight
// retry that the spend gate bounds to once.

const NOW = Date.parse("2026-10-13T02:00:00.000Z");
const FINISHED = new Date(NOW - PROVIDER_RETRY_AFTER_MS - 60_000).toISOString();
const row = (over: Partial<OnboardingRunRow> = {}): OnboardingRunRow & { account_id: string } => ({
  id: "r1",
  workspace_id: "ws1",
  account_id: "acc1",
  status: "partial",
  phases: [
    { phase: "scanning", status: "done" },
    { phase: "keywords", status: "failed", cause: "provider", detail: "Our search-data provider did not answer, so no search was checked yet. That is a problem on our side, not your site." },
    { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
    { phase: "drafting", status: "skipped" },
  ],
  planned: [],
  keywords_found: 0,
  article_id: null,
  error: null,
  empty_pool: null,
  started_at: FINISHED,
  updated_at: FINISHED,
  finished_at: FINISHED,
  ...over,
});
const GATED = { hasArticle: false, writing: false, setupAllowed: true, firstAttempted: false };

describe("a provider outage, as the screen decides it", () => {
  it("is read from the row's phases and from a pool left pending on provider errors", () => {
    expect(providerDown(stateFromRun(row(), null))).toBe(true);
    expect(providerDown({ emptyPool: { stage: "qualification", cause: null, keywords: 9, qualified: 0, rejected: {}, pending: { provider_error: 9 }, summary: "" } })).toBe(true);
    expect(providerDown(stateFromRun(row({ phases: [{ phase: "keywords", status: "failed", detail: "x" }] }), null))).toBe(false);
  });

  it("is not one failed results page among many judged: only a pool mostly left unanswered", () => {
    const pool = (pending: Record<string, number>, rejected: Record<string, number>, qualified = 0) =>
      ({ emptyPool: { stage: "qualification" as const, cause: null, keywords: 40, qualified, rejected, pending, summary: "" } });
    expect(providerDown(pool({ provider_error: 1 }, { too_hard: 30 }))).toBe(false);
    expect(providerDown(pool({ provider_error: 30 }, { too_hard: 2 }))).toBe(true);
    expect(providerDown(pool({}, { too_hard: 2 }))).toBe(false);
  });

  it("is carried by the reducer, and cleared by a later event that does not repeat it", () => {
    let s = reduceOnboarding(initialOnboardingState(), { phase: "keywords", status: "failed", cause: "provider", detail: "x" });
    expect(s.steps.find((x) => x.phase === "keywords")?.cause).toBe("provider");
    s = reduceOnboarding(s, { phase: "keywords", status: "done", detail: "y" });
    expect(s.steps.find((x) => x.phase === "keywords")?.cause).toBeUndefined();
  });

  it("ends on its own ending, ahead of the retry: no retry button, no card", () => {
    const ending = setupEnding(stateFromRun(row(), null), GATED);
    expect(ending).toBe("provider-down");
    expect(asksForCard(ending)).toBe(false);
    // An article, or one being written, still wins.
    expect(setupEnding(stateFromRun(row(), null), { ...GATED, hasArticle: true })).toBe("article");
  });

  it("promises the overnight retry only when the sweep will run it; otherwise the ordinary endings, with a way forward", () => {
    // Past the sweep's window (day four): the retry button, bounded by the gate.
    expect(setupEnding(stateFromRun(row(), null), { ...GATED, providerRetryOpen: false })).toBe("retry");
    // The spend gate would refuse the sweep: no promise, and the ordinary
    // ending for an account whose first article was attempted.
    expect(setupEnding(stateFromRun(row(), null), { ...GATED, setupAllowed: false, firstAttempted: true })).toBe("first-failed");
  });

  it("keeps the window to a night before the sweep ages a run out", () => {
    expect(providerRetryWindowOpen(new Date(NOW - 60_000).toISOString(), NOW)).toBe(true);
    expect(providerRetryWindowOpen(new Date(NOW - PROVIDER_RETRY_WITHIN_MS + 2 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(true);
    expect(providerRetryWindowOpen(new Date(NOW - PROVIDER_RETRY_WITHIN_MS + 60 * 60_000).toISOString(), NOW)).toBe(false);
    expect(providerRetryWindowOpen(new Date(NOW - 4 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(false);
    expect(providerRetryWindowOpen(null, NOW)).toBe(true);
  });

  it("the email says it is ours, promises the retry only when it will run, and offers no 'try again'", () => {
    const facts = setupFailedFacts("partial", row().phases);
    expect(facts.provider).toBe(true);
    const promised = renderSetupFailed({ domain: "acme-shop.example", ...facts, retryTonight: true });
    expect(promised.html).toContain("problem on our side, not with acme-shop.example");
    expect(promised.html).toContain("We try again automatically");
    expect(promised.html).not.toMatch(/Try again now|>Try again</);
    const notPromised = renderSetupFailed({ domain: "acme-shop.example", ...facts, retryTonight: false });
    expect(notPromised.html).not.toContain("We try again");
  });
});

describe("the overnight retry", () => {
  /** Just enough of the client for the sweep's reads. */
  function client(rows: ReturnType<typeof row>[], opts: { latest?: string; articles?: number } = {}) {
    const chain = (result: unknown) => {
      const c: Record<string, unknown> = {};
      for (const k of ["select", "eq", "neq", "lte", "gte", "order", "limit", "range", "in"]) c[k] = () => c;
      c.maybeSingle = async () => result;
      c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return c;
    };
    let runsCalls = 0;
    return {
      from(table: string) {
        if (table === "onboarding_runs") {
          runsCalls += 1;
          return runsCalls === 1 ? chain({ data: rows, error: null }) : chain({ data: { id: opts.latest ?? rows[0]?.id } });
        }
        if (table === "articles") return chain({ count: opts.articles ?? 0 });
        return chain({ data: null });
      },
    } as never;
  }

  it("starts one run for a provider-down first look the gate allows, and dispatches it", async () => {
    const start = vi.fn(async () => ({ runId: "r2", created: true }));
    const dispatch = vi.fn(async () => undefined);
    const out = await retryProviderDownRuns(client([row()]), NOW, { allowed: async () => true, start: start as never, dispatch });
    expect(out).toEqual([{ workspaceId: "ws1", runId: "r2" }]);
    expect(dispatch).toHaveBeenCalledWith("r2");
    // The funnel says this run was the overnight retry, not the person (onboarding.step).
    expect(recordRunStarted).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws1", runId: "r2", userId: null, trigger: "provider_retry" }));
  });

  it("starts nothing the spend gate refuses, for a site with an article, or for a run that is not the site's latest", async () => {
    const start = vi.fn(async () => ({ runId: "r2", created: true }));
    expect(await retryProviderDownRuns(client([row()]), NOW, { allowed: async () => false, start: start as never, dispatch: vi.fn() })).toEqual([{ workspaceId: "ws1", skipped: "not allowed" }]);
    expect(await retryProviderDownRuns(client([row()], { articles: 1 }), NOW, { allowed: async () => true, start: start as never, dispatch: vi.fn() })).toEqual([{ workspaceId: "ws1", skipped: "has an article" }]);
    expect(await retryProviderDownRuns(client([row()], { latest: "r9" }), NOW, { allowed: async () => true, start: start as never, dispatch: vi.fn() })).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("finds a provider-down run behind a full page of other partial runs", async () => {
    // Fifty partial runs that are not outages, oldest first, then the one
    // that is: the old 30-row read never reached it.
    const others = Array.from({ length: 50 }, (_, i) => row({ id: `p${i}`, workspace_id: `wsp${i}`, phases: [{ phase: "keywords", status: "failed", detail: "Your site could not be read (timeout)." }] }));
    const target = row({ id: "r1", workspace_id: "ws1" });
    let page = 0;
    const chain = (result: unknown) => {
      const c: Record<string, unknown> = {};
      for (const k of ["select", "eq", "neq", "lte", "gte", "order", "limit", "in"]) c[k] = () => c;
      c.range = () => c;
      c.maybeSingle = async () => result;
      c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return c;
    };
    let runsCalls = 0;
    const db = {
      from(table: string) {
        if (table === "onboarding_runs") {
          runsCalls += 1;
          // The first two reads are the two pages; after that, the latest-run check.
          if (runsCalls <= 2) {
            const rows = page++ === 0 ? others : [target];
            return chain({ data: rows, error: null });
          }
          return chain({ data: { id: "r1" } });
        }
        if (table === "articles") return chain({ count: 0 });
        return chain({ data: null });
      },
    } as never;
    const start = vi.fn(async () => ({ runId: "r2", created: true }));
    const out = await retryProviderDownRuns(db, NOW, { allowed: async () => true, start: start as never, dispatch: vi.fn(async () => undefined) });
    expect(out).toEqual([{ workspaceId: "ws1", runId: "r2" }]);
  });

  it("leaves a run that fell short for any other reason alone", async () => {
    const start = vi.fn();
    const other = row({ phases: [{ phase: "keywords", status: "failed", detail: "Your site could not be read (timeout)." }] });
    expect(await retryProviderDownRuns(client([other]), NOW, { allowed: async () => true, start: start as never, dispatch: vi.fn() })).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });
});
