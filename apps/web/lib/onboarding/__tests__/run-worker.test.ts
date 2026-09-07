import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "./fake-runs-client";
import { executeRun } from "../run-worker";
import type { OnboardingEvent, OnboardingRunRow } from "../events";
import type { runOnboarding } from "../pipeline";

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => { throw new Error("the test hands the worker its client"); } }));

const EVENTS: OnboardingEvent[] = [
  { phase: "scanning", status: "active" },
  { phase: "scanning", status: "done", detail: "Learned how your site writes." },
  { phase: "keywords", status: "active" },
  { phase: "keywords", status: "done", detail: "Found 94 keywords worth tracking.", keywordsFound: 94 },
  { phase: "planning", status: "active" },
  { phase: "planning", status: "done", detail: "Planned 2 articles.", planned: [{ term: "seo agent", date: "2026-09-07" }, { term: "seo tools", date: "2026-09-08" }] },
  { phase: "drafting", status: "active" },
];

const PENDING = { term: "seo agent", keywordId: "k1", selection: { reasons: ["r"], score: 1, difficulty: 10, volume: 100 } };

function db() {
  return fakeDb({
    onboarding_runs: [{ id: "r1", workspace_id: "ws1", agency_id: "ag1", status: "running", phases: [], planned: [] }],
    workspaces: [{ id: "ws1", domain: "example.com", agency_id: "ag1", language: "en", location_code: null, auto_generate_weekly_limit: 7 }],
  });
}

/** A pipeline that emits the fixed sequence and answers with `result`. */
const pipeline = (result: { pendingDraft: typeof PENDING | null }, extra: OnboardingEvent[] = []) =>
  vi.fn(async (_s, _w, emit) => {
    for (const e of [...EVENTS, ...extra]) emit(e);
    return { ...result, fanOutSettled: Promise.resolve() };
  }) as unknown as typeof runOnboarding;

let dispatch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dispatch = vi.fn(() => ({ request: Promise.resolve(new Response("{}", { status: 200 })) }));
});

describe("executeRun", () => {
  it("claims the row and persists every phase before dispatching the draft, then leaves it running", async () => {
    const d = db();
    const run = pipeline({ pendingDraft: PENDING }, [{ phase: "drafting", status: "active", detail: 'Writing "seo agent" now.' }]);
    const r = await executeRun("r1", { supabase: d.client, run, dispatch: dispatch as never, canDispatch: () => true });
    await r.keepAlive;

    expect(r.outcome).toBe("awaiting-draft");
    expect(run).toHaveBeenCalledWith(d.client, expect.objectContaining({ id: "ws1", domain: "example.com" }), expect.any(Function), { firstDraft: "dispatch" });
    const row = d.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("running");
    expect(row.phases.map((p) => `${p.phase}:${p.status}`)).toEqual(["scanning:done", "keywords:done", "planning:done", "drafting:active"]);
    expect(row.keywords_found).toBe(94);
    expect(row.planned).toHaveLength(2);
    // One write per event (the claim is separate), each in order.
    const phaseWrites = d.updates.filter((u) => u.table === "onboarding_runs" && "phases" in u.patch);
    expect(phaseWrites).toHaveLength(1 + EVENTS.length + 1);
    // The draft went out with the run id, after the last write.
    expect(dispatch).toHaveBeenCalledWith({ workspaceId: "ws1", runId: "r1", keyword: "seo agent", keywordId: "k1", selection: PENDING.selection });
    expect(dispatch.mock.invocationCallOrder[0]).toBeGreaterThan(0);
  });

  it("finishes the row itself when there is no draft to dispatch", async () => {
    const d = db();
    const run = pipeline({ pendingDraft: null }, [{ phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." }, { phase: "ready" }]);
    const r = await executeRun("r1", { supabase: d.client, run, dispatch: dispatch as never, canDispatch: () => true });
    expect(r.outcome).toBe("ran");
    expect(dispatch).not.toHaveBeenCalled();
    const row = d.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("partial");
    expect(row.finished_at).not.toBeNull();
  });

  it("runs the draft inline when the install cannot self-invoke", async () => {
    const d = db();
    const run = pipeline({ pendingDraft: null }, [{ phase: "drafting", status: "done", detail: "Wrote 1,200 words.", article: { id: "a1", title: "T", keyword: "seo agent", wordCount: 1200, verdict: "clean" } }, { phase: "ready" }]);
    const r = await executeRun("r1", { supabase: d.client, run, dispatch: dispatch as never, canDispatch: () => false });
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), { firstDraft: "inline" });
    expect(r.outcome).toBe("ran");
    const row = d.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("done");
    expect(row.article_id).toBe("a1");
  });

  it("a pipeline that throws marks the row error with the reason, keeping the phases so far", async () => {
    const d = db();
    const run = vi.fn(async (_s, _w, emit) => {
      emit(EVENTS[0]);
      emit(EVENTS[1]);
      throw new Error("Supabase unreachable");
    }) as unknown as typeof runOnboarding;
    const r = await executeRun("r1", { supabase: d.client, run, dispatch: dispatch as never, canDispatch: () => true });
    expect(r.outcome).toBe("failed");
    const row = d.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("error");
    expect(row.error).toBe("Supabase unreachable");
    expect(row.phases[0]).toMatchObject({ phase: "scanning", status: "done" });
  });

  it("a draft request that never lands closes the run as a failed draft", async () => {
    const d = db();
    dispatch.mockReturnValue({ request: Promise.reject(new Error("ECONNREFUSED")) });
    const r = await executeRun("r1", { supabase: d.client, run: pipeline({ pendingDraft: PENDING }), dispatch: dispatch as never, canDispatch: () => true });
    await r.keepAlive;
    const row = d.tables.onboarding_runs[0] as unknown as OnboardingRunRow;
    expect(row.status).toBe("partial");
    expect(row.phases[3]).toEqual({ phase: "drafting", status: "failed", detail: "The draft could not be started: ECONNREFUSED" });
  });

  it("a draft request the route refused closes the run too, unless the route already settled it", async () => {
    const d = db();
    dispatch.mockReturnValue({ request: Promise.resolve(new Response("{}", { status: 404 })) });
    const r = await executeRun("r1", { supabase: d.client, run: pipeline({ pendingDraft: PENDING }), dispatch: dispatch as never, canDispatch: () => true });
    await r.keepAlive;
    expect(d.tables.onboarding_runs[0]).toMatchObject({ status: "partial" });

    // The route's own 500 has already stamped the row; the late guard is a no-op.
    const d2 = db();
    dispatch.mockReturnValue({
      request: (async () => {
        Object.assign(d2.tables.onboarding_runs[0], { status: "partial", phases: [{ phase: "drafting", status: "failed", detail: "Model timed out." }] });
        return new Response("{}", { status: 500 });
      })(),
    });
    const r2 = await executeRun("r1", { supabase: d2.client, run: pipeline({ pendingDraft: PENDING }), dispatch: dispatch as never, canDispatch: () => true });
    await r2.keepAlive;
    expect((d2.tables.onboarding_runs[0] as unknown as OnboardingRunRow).phases[0]).toMatchObject({ detail: "Model timed out." });
  });

  it("a second worker for the same run finds it claimed and leaves", async () => {
    const d = db();
    const run = pipeline({ pendingDraft: PENDING });
    await executeRun("r1", { supabase: d.client, run, dispatch: dispatch as never, canDispatch: () => true });
    const again = await executeRun("r1", { supabase: d.client, run, dispatch: dispatch as never, canDispatch: () => true });
    expect(again.outcome).toBe("already-running");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers not-found and already-finished without running anything", async () => {
    const d = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws1", status: "done", phases: [], planned: [] }] });
    const run = pipeline({ pendingDraft: null });
    expect((await executeRun("nope", { supabase: d.client, run })).outcome).toBe("not-found");
    expect((await executeRun("r1", { supabase: d.client, run })).outcome).toBe("already-finished");
    expect(run).not.toHaveBeenCalled();
  });

  it("a run whose workspace is gone is closed as an error", async () => {
    const d = fakeDb({ onboarding_runs: [{ id: "r1", workspace_id: "ws-gone", status: "running", phases: [], planned: [] }] });
    const r = await executeRun("r1", { supabase: d.client, run: pipeline({ pendingDraft: null }), canDispatch: () => true });
    expect(r.outcome).toBe("failed");
    expect(d.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "The workspace no longer exists." });
  });
});
