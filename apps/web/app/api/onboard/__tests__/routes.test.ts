import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, asUser, type FakeDb } from "@/lib/onboarding/__tests__/fake-runs-client";

// ---------------------------------------------------------------------------
// /api/onboard/start, /run and /state against one in-memory database
// ---------------------------------------------------------------------------
//
// The user client and the service client see the same rows; only `auth` and
// the caller differ. RLS is not modelled - what is asserted here is the
// membership check every route makes before it touches a run, which is what
// stands between a signed-in stranger and another account's workspace.

let db: FakeDb;
let user: { id: string } | null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => asUser(db, user),
  createServiceClient: () => db.client,
}));

// `after()` needs a request scope; here it just runs the callback and the
// test awaits what it returned.
const deferred: Promise<unknown>[] = [];
vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => unknown) => { deferred.push(Promise.resolve().then(() => fn())); } };
});

const dispatchWorker = vi.fn(async (_id: string) => undefined);
vi.mock("@/lib/onboarding/run-dispatch", () => ({ dispatchWorker: (id: string) => dispatchWorker(id) }));

const claimRun = vi.fn();
const runClaimed = vi.fn();
vi.mock("@/lib/onboarding/run-worker", () => ({
  claimRun: (...a: unknown[]) => claimRun(...a),
  runClaimed: (...a: unknown[]) => runClaimed(...a),
}));

// The spend gate is tested on its own (lib/billing/__tests__/spend-gate.test.ts);
// here it is the answer the route acts on.
const canSpend = vi.fn();
vi.mock("@/lib/billing/spend-gate", async () => ({
  ...(await vi.importActual<typeof import("@/lib/billing/spend-gate")>("@/lib/billing/spend-gate")),
  canSpend: (...args: unknown[]) => canSpend(...args),
}));

import { POST as start } from "../start/route";
import { POST as run } from "../run/route";
import { GET as state } from "../state/route";

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const get = (path: string) => new NextRequest(`http://localhost${path}`);

beforeEach(() => {
  deferred.length = 0;
  dispatchWorker.mockClear();
  claimRun.mockReset();
  runClaimed.mockReset();
  canSpend.mockReset();
  canSpend.mockResolvedValue({ allowed: true, reason: "plan", message: null });
  user = { id: "u1" };
  db = fakeDb({
    workspaces: [
      { id: "ws1", account_id: "ag1", domain: "example.com" },
      { id: "ws2", account_id: "ag2", domain: "other.com" },
    ],
    account_members: [
      { id: "m1", account_id: "ag1", user_id: "u1" },
      { id: "m2", account_id: "ag2", user_id: "u2" },
    ],
  });
  process.env.CRON_SECRET = "s3cret";
});

describe("POST /api/onboard/start", () => {
  it("inserts a run, dispatches the worker once, and returns the id", async () => {
    const res = await start(post("/api/onboard/start", { workspaceId: "ws1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ runId: expect.any(String), existing: false });
    await Promise.all(deferred);
    expect(dispatchWorker).toHaveBeenCalledWith(body.runId);
    expect(db.tables.onboarding_runs).toHaveLength(1);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ workspace_id: "ws1", account_id: "ag1", status: "running" });
  });

  it("is idempotent: a second start returns the same run and dispatches nothing", async () => {
    const first = await (await start(post("/api/onboard/start", { workspaceId: "ws1" }))).json();
    const second = await (await start(post("/api/onboard/start", { workspaceId: "ws1" }))).json();
    expect(second).toEqual({ runId: first.runId, existing: true });
    await Promise.all(deferred);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
    expect(db.tables.onboarding_runs).toHaveLength(1);
  });

  it("a new run asks the spend gate, and a refusal starts nothing", async () => {
    // A gated account whose setup already wrote its article: another run
    // would buy the site read and the research again before the trial.
    canSpend.mockResolvedValue({ allowed: false, reason: "trial-required", message: "the gate's sentence" });
    const res = await start(post("/api/onboard/start", { workspaceId: "ws1" }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "the gate's sentence" });
    expect(canSpend).toHaveBeenCalledWith(expect.anything(), "ag1", expect.objectContaining({ workspaceId: "ws1", action: "setup" }));
    expect(db.tables.onboarding_runs ?? []).toHaveLength(0);
    await Promise.all(deferred);
    expect(dispatchWorker).not.toHaveBeenCalled();
  });

  it("hands back the live run without asking the gate: returning it buys nothing", async () => {
    const first = await (await start(post("/api/onboard/start", { workspaceId: "ws1" }))).json();
    canSpend.mockResolvedValue({ allowed: false, reason: "trial-required", message: "no" });
    const again = await start(post("/api/onboard/start", { workspaceId: "ws1" }));
    expect(await again.json()).toEqual({ runId: first.runId, existing: true });
    expect(canSpend).toHaveBeenCalledTimes(1);
  });

  it("refuses without a session, a body, or a workspace", async () => {
    user = null;
    expect((await start(post("/api/onboard/start", { workspaceId: "ws1" }))).status).toBe(401);
    user = { id: "u1" };
    expect((await start(post("/api/onboard/start", {}))).status).toBe(400);
    expect((await start(post("/api/onboard/start", { workspaceId: "nope" }))).status).toBe(404);
    expect(db.tables.onboarding_runs).toHaveLength(0);
  });

  it("another account's member cannot start a run on this workspace", async () => {
    user = { id: "u2" };
    const res = await start(post("/api/onboard/start", { workspaceId: "ws1" }));
    expect(res.status).toBe(403);
    expect(db.tables.onboarding_runs).toHaveLength(0);
    expect(dispatchWorker).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboard/run", () => {
  it("needs the cron secret", async () => {
    expect((await run(post("/api/onboard/run", { runId: "r1" }))).status).toBe(401);
    expect((await run(post("/api/onboard/run", { runId: "r1" }, { "x-cron-secret": "wrong" }))).status).toBe(401);
    expect(claimRun).not.toHaveBeenCalled();
  });

  it("claims the run, answers 202 before any of the work, and runs it after the response", async () => {
    // The dispatcher waits for this answer. It used to be the answer to the
    // whole pipeline, and past 300 s the dispatcher's fetch gave up and the
    // run was stored as failed while it was still going (2026-09-28).
    const row = { id: "r1", workspace_id: "ws1", status: "running" };
    claimRun.mockResolvedValue({ outcome: "claimed", run: row });
    let kept = false;
    // The work does not finish until the test lets it: the answer must not
    // wait for it.
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    runClaimed.mockImplementation(async () => {
      await work;
      return { outcome: "awaiting-draft", keepAlive: Promise.resolve().then(() => { kept = true; }) };
    });
    const res = await run(post("/api/onboard/run", { runId: "r1" }, { "x-cron-secret": "s3cret" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ outcome: "accepted" });
    expect(kept).toBe(false);
    finishWork();
    await Promise.all(deferred);
    expect(runClaimed).toHaveBeenCalledWith(row, { supabase: db.client });
    expect(kept).toBe(true);
  });

  it("maps a claim it did not get to a status and runs nothing", async () => {
    for (const [outcome, status] of [["not-found", 404], ["already-running", 409], ["already-finished", 409]] as const) {
      claimRun.mockResolvedValue({ outcome });
      const res = await run(post("/api/onboard/run", { runId: "r1" }, { "x-cron-secret": "s3cret" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ outcome });
    }
    await Promise.all(deferred);
    expect(runClaimed).not.toHaveBeenCalled();
  });

  it("closes the run on what it wrote when the work throws around the pipeline", async () => {
    db.tables.onboarding_runs.push({ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [{ phase: "scanning", status: "pending" }], planned: [], started_at: "2026-09-28T10:00:00Z" });
    claimRun.mockResolvedValue({ outcome: "claimed", run: db.tables.onboarding_runs[0] });
    runClaimed.mockRejectedValue(new Error("the workspace read failed"));
    expect((await run(post("/api/onboard/run", { runId: "r1" }, { "x-cron-secret": "s3cret" }))).status).toBe(202);
    await Promise.all(deferred);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "the workspace read failed" });
  });
});

describe("GET /api/onboard/state", () => {
  beforeEach(() => {
    db.tables.onboarding_runs.push({
      id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running",
      phases: [{ phase: "scanning", status: "done", detail: "Learned how your site writes." }], planned: [],
      keywords_found: null, article_id: null, error: null,
      started_at: "2026-09-07T10:00:00Z", updated_at: new Date().toISOString(), finished_at: null,
    });
  });

  it("returns the latest run for a member", async () => {
    const res = await state(get("/api/onboard/state?workspaceId=ws1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.run).toMatchObject({ id: "r1", status: "running" });
    expect(body.article).toBeNull();
    expect(body.stale).toBe(false);
    expect(body.now).toEqual(expect.any(Number));
  });

  it("joins the draft once the row points at it", async () => {
    Object.assign(db.tables.onboarding_runs[0], { status: "done", article_id: "a1" });
    db.tables.articles.push({ id: "a1", title: "T", keyword: "seo agent", word_count: 1200, fact_check_verdict: "clean", status: "review" });
    const body = await (await state(get("/api/onboard/state?workspaceId=ws1"))).json();
    expect(body.article).toEqual({ id: "a1", title: "T", keyword: "seo agent", word_count: 1200, fact_check_verdict: "clean", status: "review" });
  });

  it("another account's member gets nothing: 403 here, and RLS would hide the row anyway", async () => {
    user = { id: "u2" };
    const res = await state(get("/api/onboard/state?workspaceId=ws1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("refuses without a session or a workspace id, and 404s an unknown workspace", async () => {
    expect((await state(get("/api/onboard/state"))).status).toBe(400);
    expect((await state(get("/api/onboard/state?workspaceId=nope"))).status).toBe(404);
    user = null;
    expect((await state(get("/api/onboard/state?workspaceId=ws1"))).status).toBe(401);
  });
});
