import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "./fake-runs-client";

// The email a failed run sends. Mocked whole: the recipients, the ledger and
// the transport have their own tests; here the question is only whether a run
// that made nothing sends one and a run that made something does not.
const notifySetupFailed = vi.fn(async (..._args: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 }));
vi.mock("@/lib/email/lifecycle", () => ({ notifySetupFailed: (...a: unknown[]) => notifySetupFailed(...a) }));

import { RunRecorder, failRun, latestRun, setupFailedFacts, stampRun, startRun } from "../run-store";
import {
  initialOnboardingState,
  isRunStale,
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
