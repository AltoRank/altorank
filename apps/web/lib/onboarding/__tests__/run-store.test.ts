import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row } from "./fake-runs-client";
import type { SupabaseClient } from "@supabase/supabase-js";

// The email a failed run sends. Mocked whole: the recipients, the ledger and
// the transport have their own tests; here the question is only whether a run
// that made nothing sends one and a run that made something does not.
const notifySetupFailed = vi.fn(async (..._args: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 }));
const notifyOperatorsNothingPlanned = vi.fn(async (..._args: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 }));
vi.mock("@/lib/email/lifecycle", () => ({
  notifySetupFailed: (...a: unknown[]) => notifySetupFailed(...a),
  notifyOperatorsNothingPlanned: (...a: unknown[]) => notifyOperatorsNothingPlanned(...a),
}));

import { RunRecorder, failRun, latestRun, reapStaleRuns, setupFailedFacts, stampRun, startRun } from "../run-store";
import { asksForCard, runStateOf, setupEnding } from "../setup-retry";
import {
  failedRunNotice,
  initialOnboardingState,
  isRunStale,
  NOTHING_PLANNED_LINE,
  onboardingOutcome,
  reduceOnboarding,
  runStatusFrom,
  shouldResumeRun,
  stateFromRun,
  RUN_STALE_MS,
  STALE_RUN_ERROR,
  type OnboardingEvent,
  type OnboardingRunRow,
} from "../events";

const WS = { id: "ws1", account_id: "ag1" };

/** The event sequence a full run emits under the worker (pipeline.test.ts, "dispatch"). */
const WORKER_EVENTS: OnboardingEvent[] = [
  { phase: "scanning", status: "active" },
  { phase: "scanning", status: "done", detail: "Learned how your site writes." },
  { phase: "keywords", status: "active" },
  { phase: "keywords", status: "done", detail: "Found 94 keywords worth tracking.", keywordsFound: 94 },
  { phase: "planning", status: "active" },
  {
    phase: "planning",
    status: "done",
    detail: "Planned 7 articles over the next 30 days. Drag, drop or delete any of them.",
    planned: [{ term: "seo agent", date: "2026-09-07" }, { term: "seo tools", date: "2026-09-08" }],
  },
  { phase: "drafting", status: "active" },
  { phase: "drafting", status: "active", detail: 'Writing "seo agent" now. It lands in your review queue when it is done.' },
];

/** What the draft route stamps once the draft lands. */
const DRAFT_DONE: OnboardingEvent = { phase: "drafting", status: "done", detail: 'Wrote 1,200 words on "seo agent".' };
const ARTICLE = { id: "a1", title: "What an SEO agent does", keyword: "seo agent", wordCount: 1200, verdict: "clean" as const };
const ARTICLE_ROW = { id: "a1", title: "What an SEO agent does", keyword: "seo agent", word_count: 1200, fact_check_verdict: "clean", status: "review" };

describe("RunRecorder", () => {
  it("writes the row after every event, in order, with the reduced phases", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of WORKER_EVENTS) rec.record(e);
    await rec.flush();

    expect(rec.writes).toBe(WORKER_EVENTS.length);
    const row = db.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.phases.map((p) => `${p.phase}:${p.status}`)).toEqual([
      "scanning:done", "keywords:done", "pages:pending", "planning:done", "drafting:active",
    ]);
    expect(row.keywords_found).toBe(94);
    expect(row.planned).toHaveLength(2);
    expect(row.status).toBe("running");
    // Each write carried that moment's state, not the final one.
    const second = db.updates[1].patch as { phases: { phase: string; status: string }[] };
    expect(second.phases.map((p) => `${p.phase}:${p.status}`)).toEqual([
      "scanning:done", "keywords:pending", "pages:pending", "planning:pending", "drafting:pending",
    ]);
  });

  it("finish settles the status from what the run produced", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of WORKER_EVENTS.slice(0, 6)) rec.record(e);
    rec.record({ phase: "drafting", status: "skipped", detail: "This workspace already has a draft." });
    rec.record({ phase: "ready" });
    await rec.finish();
    const row = db.tables.onboarding_runs[0];
    expect(row.status).toBe("partial");
    expect(row.finished_at).not.toBeNull();
  });

  it("fail marks the row error with the reason and keeps the phases so far", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    rec.record(WORKER_EVENTS[0]);
    rec.record(WORKER_EVENTS[1]);
    await rec.fail("DataForSEO 40101");
    const row = db.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("error");
    expect(row.error).toBe("DataForSEO 40101");
    expect(row.phases[0]).toMatchObject({ phase: "scanning", status: "done" });
    expect(row.finished_at).not.toBeNull();
  });

  it("carries on when a write fails, and says so", async () => {
    const failing = {
      from: () => ({ update: () => ({ eq: async () => ({ error: { message: "boom" } }) }) }),
    } as never;
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rec = new RunRecorder(failing, "r1");
    rec.record(WORKER_EVENTS[0]);
    await expect(rec.flush()).resolves.toBeUndefined();
    expect(rec.writes).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not persist phases: boom"));
    warn.mockRestore();
  });
});

/**
 * The property the whole design rests on: a persisted run renders exactly as
 * the stream of its events would have. Fold the events through the reducer
 * (what the old SSE client did) and through the recorder into a row, then
 * read the row back with `stateFromRun`; the two states must be equal - both
 * before the draft lands and after the draft route has stamped it.
 */
describe("reducer parity", () => {
  it("a persisted row reads back as the reduced events, mid-run", async () => {
    const streamed = WORKER_EVENTS.reduce(reduceOnboarding, initialOnboardingState());
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of WORKER_EVENTS) rec.record(e);
    await rec.flush();
    const persisted = stateFromRun(db.tables.onboarding_runs[0] as unknown as OnboardingRunRow, null);
    expect(persisted).toEqual(streamed);
  });

  it("and once the draft route has stamped the draft and the run is over", async () => {
    const streamed = [...WORKER_EVENTS, { ...DRAFT_DONE, article: ARTICLE }, { phase: "ready" } as OnboardingEvent].reduce(
      reduceOnboarding,
      initialOnboardingState(),
    );
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of WORKER_EVENTS) rec.record(e);
    await rec.flush();
    expect(await stampRun(db.client, "r1", DRAFT_DONE, { article: ARTICLE, finish: true })).toBe(true);

    const row = db.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("done");
    expect(row.article_id).toBe("a1");
    const persisted = stateFromRun(row, ARTICLE_ROW);
    expect(persisted).toEqual(streamed);
  });

  it("a row with nothing written yet is the first frame", () => {
    const row = { id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [], keywords_found: null, article_id: null, error: null, started_at: "", updated_at: "", finished_at: null } as OnboardingRunRow;
    expect(stateFromRun(row, null)).toEqual(initialOnboardingState());
  });

  it("does not show a draft the row does not point at", () => {
    const row = { id: "r1", workspace_id: "ws1", status: "done", phases: [], planned: [], keywords_found: null, article_id: null, error: null, started_at: "", updated_at: "", finished_at: "" } as OnboardingRunRow;
    expect(stateFromRun(row, ARTICLE_ROW).article).toBeNull();
  });

  it("a stale running row reads as an error, so the screen stops waiting", () => {
    const row = { id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [], keywords_found: null, article_id: null, error: null, started_at: "", updated_at: "", finished_at: null } as OnboardingRunRow;
    const state = stateFromRun(row, null, { stale: true });
    expect(state.error).toBe(STALE_RUN_ERROR);
    expect(state.ready).toBe(false);
  });
});

describe("runStatusFrom", () => {
  it("done needs a plan and a draft; anything less is partial; a thrown run is error", () => {
    expect(runStatusFrom({ planned: [{ term: "x", date: "d" }], article: ARTICLE, error: null })).toBe("done");
    expect(runStatusFrom({ planned: [], article: ARTICLE, error: null })).toBe("partial");
    expect(runStatusFrom({ planned: [{ term: "x", date: "d" }], article: null, error: null })).toBe("partial");
    expect(runStatusFrom({ planned: [], article: null, error: "boom" })).toBe("error");
  });
});

describe("stampRun", () => {
  it("leaves a row that already left running alone", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "error", error: STALE_RUN_ERROR, phases: [], planned: [] }] });
    expect(await stampRun(db.client, "r1", DRAFT_DONE, { article: ARTICLE, finish: true })).toBe(false);
    expect(db.tables.onboarding_runs[0].status).toBe("error");
    expect(db.tables.onboarding_runs[0].article_id).toBeUndefined();
  });

  it("composes with the phases the worker left", async () => {
    const db = fakeDb({
      onboarding_runs: [{
        id: "r1", workspace_id: "ws1", status: "running",
        phases: [{ phase: "scanning", status: "done" }, { phase: "keywords", status: "done" }, { phase: "planning", status: "done" }, { phase: "drafting", status: "active" }],
        planned: [{ term: "seo agent", date: "2026-09-07" }], keywords_found: 94,
      }],
    });
    await stampRun(db.client, "r1", { phase: "drafting", status: "active", detail: "Read 8 ranking pages and 4 questions people ask. Writing now." });
    const row = db.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("running");
    expect(row.phases.find((p) => p.phase === "drafting")).toEqual({ phase: "drafting", status: "active", detail: "Read 8 ranking pages and 4 questions people ask. Writing now." });
    expect(row.phases[0]).toMatchObject({ status: "done" });
    expect(row.keywords_found).toBe(94);
  });

  it("a failed draft closes the run as partial, not error", async () => {
    const db = fakeDb({
      onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [{ phase: "drafting", status: "active" }], planned: [{ term: "x", date: "d" }] }],
    });
    await stampRun(db.client, "r1", { phase: "drafting", status: "failed", detail: "Model timed out." }, { finish: true });
    const row = db.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("partial");
    expect(row.error ?? null).toBeNull();
    expect(row.finished_at).not.toBeNull();
  });
});

describe("startRun", () => {
  it("inserts a running row for a workspace with none", async () => {
    const db = fakeDb();
    const r = await startRun(db.client, WS);
    expect(r.created).toBe(true);
    expect(db.tables.onboarding_runs).toHaveLength(1);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ id: r.runId, workspace_id: "ws1", account_id: "ag1", status: "running", phases: [] });
  });

  it("is idempotent: a second start returns the running row and inserts nothing", async () => {
    const db = fakeDb();
    const first = await startRun(db.client, WS);
    const second = await startRun(db.client, WS);
    expect(second).toEqual({ runId: first.runId, created: false });
    expect(db.tables.onboarding_runs).toHaveLength(1);
  });

  it("closes a stale running row as error and starts a fresh one", async () => {
    const now = Date.now();
    const db = fakeDb({
      onboarding_runs: [{ id: "old", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [], updated_at: new Date(now - RUN_STALE_MS - 1).toISOString() }],
    });
    const r = await startRun(db.client, WS, now);
    expect(r.created).toBe(true);
    expect(r.runId).not.toBe("old");
    expect(db.tables.onboarding_runs.find((x) => x.id === "old")).toMatchObject({ status: "error", error: STALE_RUN_ERROR });
    expect(db.tables.onboarding_runs.filter((x) => x.status === "running")).toHaveLength(1);
  });

  it("asks mayCreate only for a new run, and a sentence from it refuses one", async () => {
    const db = fakeDb();
    const mayCreate = vi.fn(async () => "refused for a reason");
    expect(await startRun(db.client, WS, Date.now(), { mayCreate })).toEqual({ refused: "refused for a reason" });
    expect(db.tables.onboarding_runs ?? []).toHaveLength(0);

    // The live run is handed back without asking: returning it buys nothing.
    const live = fakeDb({ onboarding_runs: [{ id: "live", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [], updated_at: new Date().toISOString() }] });
    const ask = vi.fn(async () => "refused");
    expect(await startRun(live.client, WS, Date.now(), { mayCreate: ask })).toEqual({ runId: "live", created: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it("a finished run does not block a new one", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "done", workspace_id: "ws1", account_id: "ag1", status: "done", phases: [], planned: [] }] });
    const r = await startRun(db.client, WS);
    expect(r.created).toBe(true);
    expect(db.tables.onboarding_runs).toHaveLength(2);
  });
});

describe("latestRun", () => {
  it("returns the newest run, its draft, and whether it is stale", async () => {
    const now = Date.now();
    const db = fakeDb({
      onboarding_runs: [
        { id: "r1", workspace_id: "ws1", status: "partial", phases: [], planned: [], started_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
        { id: "r2", workspace_id: "ws1", status: "done", phases: [], planned: [], article_id: "a1", started_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T00:00:00Z", finished_at: "2026-09-07T00:01:00Z" },
        { id: "r3", workspace_id: "other", status: "running", phases: [], planned: [], started_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" },
      ],
      articles: [ARTICLE_ROW],
    });
    const snap = await latestRun(db.client, "ws1", now);
    expect(snap.run?.id).toBe("r2");
    expect(snap.article).toEqual(ARTICLE_ROW);
    expect(snap.stale).toBe(false);
  });

  it("is empty for a workspace that never ran", async () => {
    expect(await latestRun(fakeDb().client, "ws1")).toEqual({ run: null, article: null, stale: false });
  });

  it("flags a running row nobody has written to for ten minutes", async () => {
    const now = Date.now();
    const db = fakeDb({
      onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "running", phases: [], planned: [], started_at: "x", updated_at: new Date(now - RUN_STALE_MS - 1).toISOString() }],
    });
    expect((await latestRun(db.client, "ws1", now)).stale).toBe(true);
    expect(isRunStale({ status: "done", updated_at: new Date(0).toISOString() }, now)).toBe(false);
  });
});

describe("shouldResumeRun", () => {
  const now = Date.now();
  const row = (over: Partial<OnboardingRunRow>): OnboardingRunRow =>
    ({ id: "r", workspace_id: "ws1", status: "running", phases: [], planned: [], keywords_found: null, article_id: null, error: null, started_at: "", updated_at: new Date(now).toISOString(), finished_at: null, ...over });

  it("resumes a live run, not a stale one", () => {
    expect(shouldResumeRun({ run: row({}), article: null, stale: false }, now)).toBe(true);
    expect(shouldResumeRun({ run: row({}), article: null, stale: true }, now)).toBe(false);
  });

  it("shows a run that finished in the last hour, and the wizard after that", () => {
    expect(shouldResumeRun({ run: row({ status: "done", finished_at: new Date(now - 5 * 60_000).toISOString() }), article: null, stale: false }, now)).toBe(true);
    expect(shouldResumeRun({ run: row({ status: "done", finished_at: new Date(now - 2 * 60 * 60_000).toISOString() }), article: null, stale: false }, now)).toBe(false);
    expect(shouldResumeRun({ run: row({ status: "error", finished_at: new Date(now - 60_000).toISOString() }), article: null, stale: false }, now)).toBe(true);
  });

  it("opens the wizard when there is no run", () => {
    expect(shouldResumeRun(null, now)).toBe(false);
    expect(shouldResumeRun({ run: null, article: null, stale: false }, now)).toBe(false);
  });
});

describe("a run that made nothing emails the account; a run that made something does not", () => {
  beforeEach(() => notifySetupFailed.mockClear());

  const partialNothing = [
    { phase: "scanning", status: "done", detail: "Learned how your site writes." },
    { phase: "keywords", status: "skipped", detail: "We could not reach your site just now (timed out after 10s). The next look is already scheduled; keywords and the plan will follow without you doing anything." },
    { phase: "pages", status: "skipped", detail: "No sitemap we could read, so there were no existing pages to check." },
    { phase: "planning", status: "skipped", detail: "Nothing to schedule until there are keywords." },
    { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
  ];

  it("finish(): partial with nothing produced sends once, in the run's own words, flagged transient", async () => {
    const db = fakeDb({
      onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [] }],
      workspaces: [{ id: "ws1", domain: "acme.com" }],
    });
    const rec = new RunRecorder(db.client, "r1");
    for (const p of partialNothing) rec.record({ phase: p.phase, status: p.status, detail: p.detail } as never);
    await rec.finish();
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
    const [, scope, data] = notifySetupFailed.mock.calls[0] as unknown as [unknown, { accountId: string; workspaceId: string }, { domain: string | null; line: string; transient: boolean }];
    expect(scope).toEqual({ accountId: "ag1", workspaceId: "ws1" });
    expect(data.domain).toBe("acme.com");
    expect(data.line).toContain("could not reach your site just now");
    expect(data.transient).toBe(true);
  });

  it("finish(): a run that planned a month is not a failure to email about", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of WORKER_EVENTS) rec.record(e);
    await rec.finish();
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("failRun(): the worker throwing sends, with the reason, not transient", async () => {
    const db = fakeDb({
      onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [] }],
      workspaces: [{ id: "ws1", domain: "acme.com" }],
    });
    await failRun(db.client, "r1", "The run could not be started (500).");
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
    const data = (notifySetupFailed.mock.calls[0] as unknown[])[2] as { line: string; transient: boolean };
    expect(data.line).toBe("The run could not be started (500).");
    expect(data.transient).toBe(false);
  });

  it("setupFailedFacts: the earliest reason, and transient only when the pipeline said the next look is scheduled", () => {
    const t = setupFailedFacts("partial", partialNothing);
    expect(t.line).toContain("could not reach your site");
    expect(t.transient).toBe(true);
    const d = setupFailedFacts("partial", [
      { phase: "scanning", status: "skipped", detail: "Too little readable text on the site to learn from." },
      { phase: "keywords", status: "skipped", detail: "Too little readable text on the site to tell an on-topic keyword from an off-topic one, so none were stored. Add a keyword by hand from Keywords." },
    ]);
    expect(d.line).toContain("too little readable text");
    expect(d.transient).toBe(false);
    expect(setupFailedFacts("error", null, "boom").line).toBe("boom");
  });
});

describe("reapStaleRuns", () => {
  beforeEach(() => notifySetupFailed.mockClear());

  const NOW = Date.parse("2026-09-21T18:00:00Z");
  const died = "2026-09-08T15:46:09Z";
  const run = (over: Row = {}): Row => ({
    id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running",
    phases: [{ phase: "drafting", status: "active" }], planned: [], article_id: null, error: null,
    started_at: died, updated_at: died, ...over,
  });

  it("closes a run whose worker died, wherever it is, and tells the person", async () => {
    // wesellanything.co: `running` for thirteen days because nobody reopened
    // the screen that was the only thing that ever reaped one.
    const db = fakeDb({ onboarding_runs: [run()], workspaces: [{ id: "ws1", domain: "wsa.example" }] });
    expect(await reapStaleRuns(db.client, NOW)).toEqual({ reaped: 1, runIds: ["r1"] });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: STALE_RUN_ERROR });
    expect(db.tables.onboarding_runs[0].finished_at).not.toBeNull();
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
  });

  it("leaves a run that is merely slow", async () => {
    const db = fakeDb({ onboarding_runs: [run({ updated_at: new Date(NOW - RUN_STALE_MS + 60_000).toISOString() })] });
    expect(await reapStaleRuns(db.client, NOW)).toEqual({ reaped: 0, runIds: [] });
    expect(db.tables.onboarding_runs[0].status).toBe("running");
  });

  it("settles a run that produced something on what it produced, without emailing about it", async () => {
    const db = fakeDb({
      onboarding_runs: [run({ article_id: "a1" })],
      workspaces: [{ id: "ws1", domain: "wsa.example" }],
      articles: [{ id: "a1", workspace_id: "ws1", status: "review", word_count: 900, created_at: "2026-09-08T15:50:00Z" }],
    });
    expect((await reapStaleRuns(db.client, NOW)).reaped).toBe(1);
    // A draft and no plan: partial, and no error the screen would print.
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "partial", error: null });
    expect(db.tables.onboarding_runs[0].finished_at).not.toBeNull();
    expect(notifySetupFailed).not.toHaveBeenCalled();
    // The operator still hears that it was cut off.
    expect(db.tables.system_events?.[0]).toMatchObject({ level: "warn", source: "onboarding.run" });
  });

  it("takes one row when the caller names one, and every stale row when it does not", async () => {
    const two = { onboarding_runs: [run(), run({ id: "r2", workspace_id: "ws2" })], workspaces: [{ id: "ws1", domain: "a.example" }, { id: "ws2", domain: "b.example" }] };
    expect((await reapStaleRuns(fakeDb(structuredClone(two)).client, NOW, { runId: "r2" })).runIds).toEqual(["r2"]);
    expect((await reapStaleRuns(fakeDb(structuredClone(two)).client, NOW)).reaped).toBe(2);
  });

  it("closes nothing, and does not throw, when the read fails", async () => {
    const client = { from: () => ({ select: () => { const q: Record<string, unknown> = {}; for (const m of ["eq", "lt", "order"]) q[m] = () => q; q.limit = async () => ({ data: null, error: { message: "gone" } }); return q; } }) } as unknown as SupabaseClient;
    expect(await reapStaleRuns(client, NOW)).toEqual({ reaped: 0, runIds: [] });
  });
});

// ---------------------------------------------------------------------------
// Closing a run from outside the worker: what it wrote decides, not the caller
// ---------------------------------------------------------------------------
//
// 2026-09-28: a local first look finished at 5:00 and was stored as "The run
// could not be started: fetch failed" by a dispatcher whose fetch had given
// up at 300 s, and the setup-failed email went out. failRun now reads the rows
// the run wrote, and the dispatcher closes only a run no worker claimed.
describe("failRun derives what the run produced from its rows", () => {
  beforeEach(() => {
    notifySetupFailed.mockClear();
    notifyOperatorsNothingPlanned.mockClear();
  });
  const STARTED = "2026-09-28T10:00:00.000Z";
  const running = (over: Row = {}): Row => ({
    id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running",
    phases: [{ phase: "planning", status: "active" }], planned: [], article_id: null, error: null,
    started_at: STARTED, updated_at: STARTED, ...over,
  });

  it("a run with a draft on its site since it started is not failed, and nobody is emailed", async () => {
    // The draft route writes the article; the row never pointed at it.
    const db = fakeDb({
      onboarding_runs: [running()],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
      articles: [{ id: "a9", workspace_id: "ws1", status: "review", word_count: 900, created_at: "2026-09-28T10:04:30.000Z" }],
    });
    expect(await failRun(db.client, "r1", "The run could not be started: fetch failed")).toBe(true);
    // Settled on that draft, and the row now points at it: a row that says
    // partial with no article_id read back as a run with nothing to show.
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "partial", error: null, article_id: "a9" });
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("a run with a plan and a draft is settled done", async () => {
    const db = fakeDb({
      onboarding_runs: [running({ planned: [{ term: "t", date: "2026-09-29" }], article_id: "a1" })],
      articles: [{ id: "a1", workspace_id: "ws1", status: "review", word_count: 900, created_at: "2026-09-28T10:03:00.000Z" }],
    });
    await failRun(db.client, "r1", "cut off");
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "done", error: null, article_id: "a1" });
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("an older article, or one whose draft failed, is not something this run wrote", async () => {
    const db = fakeDb({
      onboarding_runs: [running()],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
      articles: [
        { id: "old", workspace_id: "ws1", status: "review", created_at: "2026-09-01T00:00:00.000Z" },
        { id: "bad", workspace_id: "ws1", status: "error", created_at: "2026-09-28T10:02:00.000Z" },
        { id: "other", workspace_id: "ws2", status: "review", created_at: "2026-09-28T10:02:00.000Z" },
      ],
    });
    await failRun(db.client, "r1", "boom");
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "boom" });
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
  });

  it("unclaimedOnly leaves a run a worker has claimed alone", async () => {
    const db = fakeDb({ onboarding_runs: [running({ phases: [{ phase: "scanning", status: "pending" }] })] });
    expect(await failRun(db.client, "r1", "fetch failed", { unclaimedOnly: true })).toBe(false);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running", error: null });
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("unclaimedOnly closes a run nobody claimed: it never started", async () => {
    const db = fakeDb({ onboarding_runs: [running({ phases: [] })], workspaces: [{ id: "ws1", domain: "acme-clinic.example" }] });
    expect(await failRun(db.client, "r1", "The run could not be started (500).", { unclaimedOnly: true })).toBe(true);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "The run could not be started (500)." });
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Nothing cleared the bar: its own outcome, not a failure
// ---------------------------------------------------------------------------
describe("a run that planned nothing without failing", () => {
  beforeEach(() => {
    notifySetupFailed.mockClear();
    notifyOperatorsNothingPlanned.mockClear();
  });

  const POOL = {
    stage: "qualification" as const,
    cause: "buyer_mismatch",
    keywords: 144,
    qualified: 0,
    rejected: { buyer_mismatch: 110, not_editorial: 4, existing_page: 2, needs_page: 1 },
    pending: { unjudged: 27 },
    summary: "None of 144 searches qualified; the largest group: not a buyer search (...).",
  };
  const EMPTY: OnboardingEvent[] = [
    { phase: "scanning", status: "done", detail: "Learned how your site writes." },
    { phase: "keywords", status: "done", detail: "34 keywords found.", keywordsFound: 144 },
    { phase: "pages", status: "done", detail: "Checked 12 pages." },
    { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet.", planned: [], emptyPool: POOL },
    { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
    { phase: "ready" },
  ];

  it("finish(): stored as nothing_planned with the empty pool; no setup-failed email; the operators are told", async () => {
    const db = fakeDb({
      onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [], error: null }],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
    });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of EMPTY) rec.record(e);
    await rec.finish();

    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "nothing_planned", error: null, empty_pool: POOL });
    expect(notifySetupFailed).not.toHaveBeenCalled();
    expect(notifyOperatorsNothingPlanned).toHaveBeenCalledTimes(1);
    expect(notifyOperatorsNothingPlanned.mock.calls[0][1]).toEqual({ accountId: "ag1", workspaceId: "ws1" });
    // No billing in this environment, so no trial: the account was never
    // shown the 24-hour promise, and the operator email says so.
    expect(notifyOperatorsNothingPlanned.mock.calls[0][2]).toEqual({ runId: "r1", domain: "acme-clinic.example", pool: POOL, preTrial: false });
    expect(db.tables.system_events).toEqual([
      expect.objectContaining({
        level: "warn",
        source: "onboarding.nothing_planned",
        context: expect.objectContaining({ runId: "r1", stage: "qualification", cause: "buyer_mismatch", rows: 144, qualified: 0 }),
      }),
    ]);
    expect(String(db.tables.system_events[0].message)).toContain(POOL.summary);
  });

  it("reads back as the same outcome on the screen", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    for (const e of EMPTY) rec.record(e);
    await rec.finish();
    const state = stateFromRun(db.tables.onboarding_runs[0] as unknown as OnboardingRunRow, null);
    expect(state.emptyPool).toEqual(POOL);
    expect(runStatusFrom(state)).toBe("nothing_planned");
    expect(onboardingOutcome(state)).toEqual({ tone: "nothing_planned", line: NOTHING_PLANNED_LINE, produced: false });
    // Not a failure anywhere downstream: no dashboard bar, no retry.
    expect(failedRunNotice({ run: db.tables.onboarding_runs[0] as unknown as OnboardingRunRow, article: null, stale: false })).toBeNull();
  });

  it("a phase that failed on the way is still a setup that fell short", () => {
    const failed = [...EMPTY.slice(0, 1), { phase: "keywords", status: "failed", detail: "provider down" } as OnboardingEvent, ...EMPTY.slice(2)];
    const state = failed.reduce(reduceOnboarding, initialOnboardingState());
    expect(runStatusFrom(state)).toBe("partial");
  });

  it("without the pipeline's empty-pool report the run stays partial, as before", () => {
    const state = EMPTY.map((e) => ("emptyPool" in e ? { ...e, emptyPool: undefined } : e)).reduce(reduceOnboarding, initialOnboardingState());
    expect(runStatusFrom(state)).toBe("partial");
  });

  it("an older partial row without the column reads as partial", () => {
    const row = { id: "r1", workspace_id: "ws1", status: "partial", phases: [], planned: [], keywords_found: 3, article_id: null, error: null, started_at: "", updated_at: "", finished_at: "" } as OnboardingRunRow;
    expect(stateFromRun(row, null).emptyPool).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review, 2026-09-29: a nothing-planned run closed from outside its worker,
// and pools that are empty only because something broke
// ---------------------------------------------------------------------------
describe("a nothing-planned run cut off after planning", () => {
  beforeEach(() => {
    notifySetupFailed.mockClear();
    notifyOperatorsNothingPlanned.mockClear();
  });
  const NOW = Date.parse("2026-09-28T11:00:00Z");
  const STARTED = "2026-09-28T10:00:00.000Z";
  const POOL = {
    stage: "qualification" as const,
    cause: "buyer_mismatch",
    keywords: 144,
    qualified: 0,
    rejected: { buyer_mismatch: 117 },
    pending: { unjudged: 27 },
    summary: "None of 144 searches qualified.",
  };
  // Planning wrote the empty pool; the worker died, or threw, while the
  // drafting phase was still looking.
  const cutOff = (over: Row = {}): Row => ({
    id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running",
    phases: [
      { phase: "scanning", status: "done" },
      { phase: "keywords", status: "done", detail: "34 keywords found." },
      { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
      { phase: "drafting", status: "active" },
    ],
    planned: [], article_id: null, error: null, empty_pool: POOL,
    started_at: STARTED, updated_at: STARTED, ...over,
  });

  it("the reaper settles it as nothing_planned: no setup-failed email, the operators are told", async () => {
    const db = fakeDb({ onboarding_runs: [cutOff()], workspaces: [{ id: "ws1", domain: "acme-clinic.example" }] });
    expect(await reapStaleRuns(db.client, NOW)).toEqual({ reaped: 1, runIds: ["r1"] });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "nothing_planned", error: null });
    expect(notifySetupFailed).not.toHaveBeenCalled();
    expect(notifyOperatorsNothingPlanned).toHaveBeenCalledTimes(1);
    expect(db.tables.system_events).toEqual([
      expect.objectContaining({ source: "onboarding.nothing_planned", context: expect.objectContaining({ closedBecause: STALE_RUN_ERROR }) }),
    ]);
  });

  it("failRun (the worker threw after planning) settles it the same way", async () => {
    const db = fakeDb({ onboarding_runs: [cutOff()], workspaces: [{ id: "ws1", domain: "acme-clinic.example" }] });
    expect(await failRun(db.client, "r1", "boom")).toBe(true);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "nothing_planned", error: null });
    expect(notifySetupFailed).not.toHaveBeenCalled();
    expect(notifyOperatorsNothingPlanned).toHaveBeenCalledTimes(1);
  });

  it("the screen reads the stale, not-yet-reaped row the way the reaper will settle it", () => {
    const row = cutOff() as unknown as OnboardingRunRow;
    const snapshot = { run: row, article: null, stale: isRunStale(row, NOW) };
    expect(snapshot.stale).toBe(true);
    const state = runStateOf(snapshot)!;
    expect(state.error).toBeNull();
    expect(onboardingOutcome(state).tone).toBe("nothing_planned");
    const ending = setupEnding(state, { hasArticle: false, writing: false, setupAllowed: true, firstAttempted: false });
    expect(ending).toBe("nothing-planned");
    expect(asksForCard(ending)).toBe(false);
    expect(failedRunNotice(snapshot)).toBeNull();
  });

  it("a stale row whose pool was never judged is still the run that stopped responding", () => {
    const row = cutOff({ empty_pool: { ...POOL, rejected: {}, pending: { provider_error: 60 } } }) as unknown as OnboardingRunRow;
    const state = runStateOf({ run: row, article: null, stale: true })!;
    expect(state.error).toBe(STALE_RUN_ERROR);
  });

  it("a pool emptied by a failed provider is closed as an error, with the email and the retry", async () => {
    const db = fakeDb({
      onboarding_runs: [cutOff({ empty_pool: { ...POOL, rejected: {}, pending: { provider_error: 60 } } })],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
    });
    await failRun(db.client, "r1", "boom");
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "boom" });
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
    expect(notifyOperatorsNothingPlanned).not.toHaveBeenCalled();
  });
});

describe("what a closed run counts as its own draft", () => {
  beforeEach(() => notifySetupFailed.mockClear());
  const STARTED = "2026-09-28T10:00:00.000Z";
  const running = (over: Row = {}): Row => ({
    id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running",
    phases: [{ phase: "drafting", status: "active" }], planned: [], article_id: null, error: null,
    started_at: STARTED, updated_at: STARTED, ...over,
  });

  it("a draft still being written is not a draft: failRun leaves the run to the draft route", async () => {
    const db = fakeDb({
      onboarding_runs: [running()],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
      articles: [{ id: "a1", workspace_id: "ws1", status: "drafting", word_count: 0, created_at: "2026-09-28T10:02:00.000Z" }],
    });
    expect(await failRun(db.client, "r1", "boom")).toBe(false);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running" });
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("the reaper closes it anyway once it is stale, on what is readable - here nothing", async () => {
    const db = fakeDb({
      onboarding_runs: [running()],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
      articles: [{ id: "a1", workspace_id: "ws1", status: "drafting", word_count: 0, created_at: "2026-09-28T10:02:00.000Z" }],
    });
    expect((await reapStaleRuns(db.client, Date.parse("2026-09-28T11:00:00Z"))).reaped).toBe(1);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: STALE_RUN_ERROR });
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
  });

  it("an empty review row, or the row's own draft that failed, is not something the person can open", async () => {
    const db = fakeDb({
      onboarding_runs: [running({ article_id: "mine" })],
      workspaces: [{ id: "ws1", domain: "acme-clinic.example" }],
      articles: [
        { id: "mine", workspace_id: "ws1", status: "error", word_count: 0, created_at: "2026-09-28T10:02:00.000Z" },
        { id: "empty", workspace_id: "ws1", status: "review", word_count: 0, created_at: "2026-09-28T10:03:00.000Z" },
      ],
    });
    await failRun(db.client, "r1", "boom");
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "boom" });
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
  });
});

describe("RunRecorder.finish after somebody else closed the run", () => {
  beforeEach(() => {
    notifySetupFailed.mockClear();
    notifyOperatorsNothingPlanned.mockClear();
  });

  it("announces nothing: the stored status and its announcement stand", async () => {
    const db = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [] }] });
    const rec = new RunRecorder(db.client, "r1");
    rec.record({ phase: "scanning", status: "failed", detail: "blocked" });
    await rec.flush();
    // The reaper got there first.
    db.tables.onboarding_runs[0].status = "error";
    await rec.finish();
    expect(db.tables.onboarding_runs[0].status).toBe("error");
    expect(db.tables.system_events ?? []).toEqual([]);
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });
});

describe("runStatusFrom: nothing_planned only for a pool that was judged", () => {
  const judged = {
    stage: "qualification" as const,
    cause: "buyer_mismatch",
    keywords: 60,
    qualified: 0,
    rejected: { buyer_mismatch: 50 } as Record<string, number>,
    pending: {} as Record<string, number>,
    summary: "",
  };
  const settle = (emptyPool: typeof judged | null) =>
    runStatusFrom({ planned: [], article: null, error: null, steps: [{ phase: "planning", status: "skipped" }], emptyPool: emptyPool as never });

  it("every row reached was answered, and none qualified", () => {
    expect(settle(judged)).toBe("nothing_planned");
    // Rows the first look's four batches never reached are budget, not breakage.
    expect(settle({ ...judged, pending: { unjudged: 200 } })).toBe("nothing_planned");
    // A results page too thin to judge against is a reading, not a failed call.
    expect(settle({ ...judged, rejected: {}, pending: { thin_serp: 12 } })).toBe("nothing_planned");
    expect(settle({ ...judged, stage: "keywords" as never, keywords: 0, rejected: {} })).toBe("nothing_planned");
  });

  it("a pool that is empty because something broke stays partial: the failure email and the retry", () => {
    for (const cause of ["provider_error", "no_verdict", "judge_incomplete", "no_profile", "unspecified"]) {
      expect(settle({ ...judged, pending: { [cause]: 3 } })).toBe("partial");
    }
    // Nothing judged at all: no model key leaves every row unjudged.
    expect(settle({ ...judged, rejected: {}, pending: { unjudged: 30 } })).toBe("partial");
    // Something qualified and the planner placed none: the planner fell short.
    expect(settle({ ...judged, stage: "planning" as never, qualified: 4 })).toBe("partial");
    expect(settle(null)).toBe("partial");
  });
});
