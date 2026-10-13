import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, type FakeDb } from "./fake-runs-client";
import type { OnboardingEvent } from "../events";

// ---------------------------------------------------------------------------
// The dispatcher, the real worker route and the real worker, end to end
// ---------------------------------------------------------------------------
//
// On 2026-09-28 a local first look took five minutes. The dispatcher awaited
// the worker's whole response, Node's fetch gave up waiting for headers at
// 300 s, and the run was stored as "The run could not be started: fetch
// failed" with a setup-failed email - while the worker was still going, and
// it then finished. Here the dispatcher's fetch is the real /api/onboard/run
// handler, the pipeline is the only thing replaced, and time is simulated.

let db: FakeDb;
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db.client }));

// `after()` needs a request scope; here it runs the callback and the test
// awaits what it returned.
const deferred: Promise<unknown>[] = [];
vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => unknown) => { deferred.push(Promise.resolve().then(() => fn())); } };
});

const notifySetupFailed = vi.fn(async (..._a: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 }));
const notifyOperatorsNothingPlanned = vi.fn(async (..._a: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 }));
vi.mock("@/lib/email/lifecycle", () => ({
  notifySetupFailed: (...a: unknown[]) => notifySetupFailed(...a),
  notifyOperatorsNothingPlanned: (...a: unknown[]) => notifyOperatorsNothingPlanned(...a),
}));
vi.mock("@/lib/email/draft-batch", () => ({ announceDraftBatch: vi.fn(async () => "nothing to announce") }));

/** How long the pipeline takes, in simulated milliseconds. */
let pipelineMs = 0;
/** What the pipeline emits once it is done. */
let events: OnboardingEvent[] = [];
vi.mock("../pipeline", () => ({
  runOnboarding: async (_s: unknown, _w: unknown, emit: (e: OnboardingEvent) => void) => {
    emit({ phase: "scanning", status: "active" });
    await new Promise((resolve) => setTimeout(resolve, pipelineMs));
    for (const e of events) emit(e);
    return { pendingDraft: null, fanOutSettled: Promise.resolve() };
  },
}));

import { dispatchWorker } from "../run-dispatch";
import { POST as runRoute } from "@/app/api/onboard/run/route";

const FULL: OnboardingEvent[] = [
  { phase: "scanning", status: "done", detail: "Learned how your site writes." },
  { phase: "keywords", status: "done", detail: "Found 40 keywords.", keywordsFound: 40 },
  { phase: "planning", status: "done", detail: "Prepared 1 article.", planned: [{ term: "acme widgets", date: "2026-09-30" }] },
  { phase: "drafting", status: "done", detail: "Wrote it.", article: { id: "a1", title: "Acme widgets", keyword: "acme widgets", wordCount: 1200, verdict: "clean" } },
  { phase: "ready" },
];

const HOW = { baseUrl: "http://127.0.0.1:3999", secret: "s3cret" };

/** A fetch that is the worker route itself. */
const toRoute = async (url: string | URL | Request, init?: RequestInit) =>
  runRoute(new NextRequest(String(url), init as ConstructorParameters<typeof NextRequest>[1]));

beforeEach(() => {
  vi.useFakeTimers();
  deferred.length = 0;
  notifySetupFailed.mockClear();
  notifyOperatorsNothingPlanned.mockClear();
  process.env.CRON_SECRET = HOW.secret;
  process.env.NEXT_PUBLIC_APP_URL = HOW.baseUrl;
  pipelineMs = 0;
  events = FULL;
  db = fakeDb({
    onboarding_runs: [{ id: "r1", workspace_id: "ws1", account_id: "ag1", status: "running", phases: [], planned: [], error: null, started_at: "2026-09-28T10:00:00.000Z" }],
    workspaces: [{ id: "ws1", domain: "acme-clinic.example", account_id: "ag1", language: "en", location_code: null, auto_generate_weekly_limit: 7 }],
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("dispatchWorker with a slow worker", () => {
  it("returns once the worker has claimed the run, and the run ends as the worker records it, past 300 s", async () => {
    pipelineMs = 301_000;
    const fetchImpl = vi.fn(toRoute) as unknown as typeof fetch;

    await dispatchWorker("r1", { ...HOW, fetchImpl });

    // The dispatcher is done; the worker has the run and is still going.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running", error: null });

    // Five minutes later: the point at which the awaited fetch used to die.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running", error: null });

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(deferred);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "done", error: null });
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("a fetch that fails after the worker claimed the run does not mark it failed or email anyone", async () => {
    // The 2026-09-28 failure exactly: the request reached the worker, the
    // dispatcher's fetch then threw.
    pipelineMs = 301_000;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      await toRoute(url, init);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await dispatchWorker("r1", { ...HOW, fetchImpl });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running", error: null });

    await vi.advanceTimersByTimeAsync(301_000);
    await Promise.all(deferred);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "done", error: null });
    expect(notifySetupFailed).not.toHaveBeenCalled();
  });

  it("a slow run that planned nothing ends nothing_planned: no setup-failed email, the operators are told", async () => {
    pipelineMs = 320_000;
    events = [
      { phase: "scanning", status: "done", detail: "Learned how your site writes." },
      { phase: "keywords", status: "done", detail: "Found 40 keywords.", keywordsFound: 40 },
      {
        phase: "planning",
        status: "skipped",
        detail: "No keyword clear enough to plan yet.",
        planned: [],
        emptyPool: { stage: "qualification", cause: "buyer_mismatch", keywords: 40, qualified: 0, rejected: { buyer_mismatch: 40 }, pending: {}, summary: "None of 40 searches qualified." },
      },
      { phase: "drafting", status: "skipped", detail: "No keyword clear enough to write to yet." },
      { phase: "ready" },
    ];
    await dispatchWorker("r1", { ...HOW, fetchImpl: toRoute as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(320_000);
    await Promise.all(deferred);
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "nothing_planned", error: null });
    expect(notifySetupFailed).not.toHaveBeenCalled();
    expect(notifyOperatorsNothingPlanned).toHaveBeenCalledTimes(1);
  });

  it("a hand-off that never reached a worker closes the run it could not start", async () => {
    const fetchImpl = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await dispatchWorker("r1", { ...HOW, fetchImpl });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "The run could not be started: fetch failed" });
    expect(notifySetupFailed).toHaveBeenCalledTimes(1);
  });

  it("a worker route that refused the run closes it; a 409 (claimed elsewhere) does not", async () => {
    await dispatchWorker("r1", { ...HOW, fetchImpl: (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "running" });
    await dispatchWorker("r1", { ...HOW, fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    expect(db.tables.onboarding_runs[0]).toMatchObject({ status: "error", error: "The run could not be started (500)." });
  });
});
