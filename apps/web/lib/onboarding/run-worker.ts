// ---------------------------------------------------------------------------
// One onboarding run, executed against its row
// ---------------------------------------------------------------------------
//
// What /api/onboard/run does once it has checked the secret, kept out of the
// route so the start route can run it inline when there is no way to
// self-invoke. Service client throughout: there is no user session here, and
// the row is written by the service role only (076).
//
// The draft is handed off, not awaited. A draft is 100-280s on its own and
// this invocation has the same 300s budget, so writing it here would put the
// worker back at the ceiling the SSE route used to reach. /api/internal/draft
// gets it in its own invocation and stamps the row when it lands; this
// returns with the row still `running`, and the request it fired is handed
// back for the route to keep alive with after().

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { canSelfInvoke, dispatchFirstDraft } from "@/lib/content/fan-out";
import { announceDraftBatch } from "@/lib/email/draft-batch";
import { runOnboarding } from "./pipeline";
import { RunRecorder, RUN_COLUMNS, stampRun } from "./run-store";
import type { OnboardingRunRow } from "./events";
import { RunClock, saveRunTimings } from "./timings";

export type ExecuteOutcome =
  | "not-found"
  | "already-running"
  | "already-finished"
  | "ran"
  | "awaiting-draft"
  | "failed";

export interface ExecuteResult {
  outcome: ExecuteOutcome;
  /**
   * Requests this run fired and did not wait for - the first draft, the
   * fan-out - followed by the one email that tells the account what they all
   * wrote. Never rejects. The route hands it to `after()` so the function is
   * not frozen with them still in its socket buffer.
   */
  keepAlive: Promise<void>;
}

export interface ExecuteDeps {
  supabase?: SupabaseClient;
  run?: typeof runOnboarding;
  dispatch?: typeof dispatchFirstDraft;
  canDispatch?: () => boolean;
  announce?: typeof announceDraftBatch;
}

/**
 * Tell the account about what this run wrote itself.
 *
 * Only a run that wrote its draft inline (or wrote none) announces from here.
 * A dispatched draft is announced by /api/internal/draft, the moment it stamps
 * the row ready: this used to wait for that request inside `keepAlive`, in a
 * worker whose 300s the pipeline had mostly spent already, so the platform cut
 * it off before the draft landed and the email waited for cron/generate's
 * sweep - 42 minutes after the draft existed, for a real signup on
 * 2026-09-22. The page and the email now hear about the draft from the same
 * place at the same time.
 *
 * Chained onto `keepAlive` rather than awaited, so the route's response still
 * goes out immediately. If it is cut short anyway - `after()` has no
 * guarantee - `sweepUnannouncedDrafts` in cron/generate catches the workspace
 * on its next pass.
 */
function announceWhenSettled(
  supabase: SupabaseClient,
  workspaceId: string,
  keepAlive: Promise<void>,
  announce: typeof announceDraftBatch,
): Promise<void> {
  return keepAlive
    .then(() => announce(supabase, workspaceId))
    .then(() => undefined, () => undefined);
}

/**
 * How often a working run looks at its own row for a stop: the owner closing
 * it to change what it was started on (./stop-to-change.ts). A few seconds of
 * research is what a stop can still buy.
 */
export const STOP_LOOK_MS = 4_000;

/**
 * Watch the run's row while the pipeline works, and abort `signal` once the
 * row is no longer `running`. The pipeline bounds every provider call by it
 * (./deadline.ts). A look that fails is not a stop.
 */
function watchForStop(supabase: SupabaseClient, runId: string, every = STOP_LOOK_MS): { signal: AbortSignal; closed: () => Promise<boolean>; end: () => void } {
  const controller = new AbortController();
  const closed = async (): Promise<boolean> => {
    if (controller.signal.aborted) return true;
    const { data, error } = await supabase.from("onboarding_runs").select("status").eq("id", runId).maybeSingle();
    if (error || !data) return false;
    if ((data as { status: string }).status === "running") return false;
    controller.abort(new Error("The run was stopped."));
    return true;
  };
  let looking = false;
  const timer = setInterval(() => {
    if (looking || controller.signal.aborted) return;
    looking = true;
    closed()
      .catch(() => false)
      .finally(() => {
        looking = false;
      });
  }, every);
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, closed, end: () => clearInterval(timer) };
}

interface WorkerWorkspace {
  id: string;
  domain: string | null;
  account_id: string;
  language: string | null;
  location_code: number | null;
  auto_generate_weekly_limit: number | null;
  /** Seeds the keyword phase from the business, not only from page headings. */
  business_profile?: unknown;
}

/** A run this worker now owns, or why it does not own one. */
export type ClaimResult =
  | { outcome: "claimed"; run: OnboardingRunRow }
  | { outcome: Extract<ExecuteOutcome, "not-found" | "already-running" | "already-finished"> };

/**
 * Claim the run for this worker. A run is dispatched once, but a retried
 * dispatch or a start that raced could send two workers; the second finds
 * `phases` no longer empty and leaves. Atomic in the update's WHERE, so both
 * cannot pass - and so can the dispatcher's own close of a run nobody claimed
 * (`failRun` with `unclaimedOnly`): whichever writes first wins.
 *
 * Quick on purpose: /api/onboard/run answers once this returns, and runs the
 * rest (`runClaimed`) after its response.
 */
export async function claimRun(supabase: SupabaseClient, runId: string): Promise<ClaimResult> {
  const { data: found } = await supabase.from("onboarding_runs").select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  const run = found as OnboardingRunRow | null;
  if (!run) return { outcome: "not-found" };
  if (run.status !== "running") return { outcome: "already-finished" };

  const { data: claimed } = await supabase
    .from("onboarding_runs")
    .update({ phases: [{ phase: "scanning", status: "pending" }], updated_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "running")
    .eq("phases", "[]")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { outcome: "already-running" };
  return { outcome: "claimed", run };
}

/** Claim the run and do it, start to finish, in this call: the inline path. */
export async function executeRun(runId: string, deps: ExecuteDeps = {}): Promise<ExecuteResult> {
  const supabase = deps.supabase ?? createServiceClient();
  const claim = await claimRun(supabase, runId);
  if (claim.outcome !== "claimed") return { outcome: claim.outcome, keepAlive: Promise.resolve() };
  return runClaimed(claim.run, { ...deps, supabase });
}

/**
 * Do a run this worker has claimed. Everything it decides - done, partial,
 * nothing planned, failed - is written to the row from here or by the draft
 * route it hands the draft to; nobody waiting on a request decides it.
 */
export async function runClaimed(run: OnboardingRunRow, deps: ExecuteDeps = {}): Promise<ExecuteResult> {
  const supabase = deps.supabase ?? createServiceClient();
  const runId = run.id;
  const settled = { outcome: "failed" as ExecuteOutcome, keepAlive: Promise.resolve() };
  const recorder = new RunRecorder(supabase, runId);

  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, domain, account_id, language, location_code, auto_generate_weekly_limit, business_profile")
    .eq("id", run.workspace_id)
    .maybeSingle();
  const workspace = ws as WorkerWorkspace | null;
  if (!workspace) {
    await recorder.fail("The workspace no longer exists.");
    return settled;
  }

  const canDispatch = (deps.canDispatch ?? canSelfInvoke)();
  // The run's stopwatch, on the run's own axis (started_at), so the draft
  // route's stages land on the same timeline when it merges its own.
  const clock = new RunClock(run.started_at);
  const watch = watchForStop(supabase, runId);
  let result: Awaited<ReturnType<typeof runOnboarding>>;
  try {
    result = await (deps.run ?? runOnboarding)(supabase, workspace, recorder.record, {
      firstDraft: canDispatch ? "dispatch" : "inline",
      runId,
      clock,
      stop: watch.signal,
      // Every phase so far on the row first: a stop decided on "still finding
      // searches" then either landed before this look or is refused by the
      // row it reads (run-store.ts, stopRunToChange).
      stillWanted: async () => {
        await recorder.flush();
        return !(await watch.closed().catch(() => false));
      },
    });
  } catch (err) {
    watch.end();
    await recorder.fail(err instanceof Error ? err.message : "Onboarding failed.");
    await saveRunTimings(supabase, runId, clock);
    return settled;
  }
  watch.end();
  // Every phase is on the row before anything else may write to it.
  await recorder.flush();
  // Where the worker's time went, before the draft route adds its own.
  if (!result.pendingDraft) clock.mark("run_done");
  await saveRunTimings(supabase, runId, clock);

  const announce = deps.announce ?? announceDraftBatch;

  // The speed test the analysis did not wait for (lib/audit/domain-analysis.ts).
  const tail = result.tailSettled ?? Promise.resolve();
  const pending = result.pendingDraft;
  if (!pending) {
    await recorder.finish();
    return {
      outcome: "ran",
      keepAlive: Promise.all([announceWhenSettled(supabase, workspace.id, result.fanOutSettled, announce), tail]).then(() => undefined, () => undefined),
    };
  }

  const sent = (deps.dispatch ?? dispatchFirstDraft)({
    workspaceId: workspace.id,
    runId,
    keyword: pending.term,
    keywordId: pending.keywordId,
    selection: pending.selection,
    // Its share of the run's one related-keyword task, so the draft route
    // does not buy a second one (lib/seo/brief-data.ts).
    relatedKeywords: pending.relatedKeywords,
    // The results page this run judged it on: the draft's research reads it.
    ...(pending.serp ? { serp: pending.serp } : {}),
  });
  if ("skipped" in sent) {
    // canSelfInvoke said yes a moment ago; only an env change between the
    // two calls gets here. Close the run honestly rather than leave it
    // spinning for a draft nobody will write.
    await stampRun(supabase, runId, { phase: "drafting", status: "failed", detail: "The draft could not be started on this install." }, { finish: true });
    // The fan-out may still have landed six drafts; they are still news.
    return {
      outcome: "failed",
      keepAlive: announceWhenSettled(supabase, workspace.id, result.fanOutSettled, announce),
    };
  }

  // The draft route stamps the row itself, on success and on its own
  // failures, and sends the email when it stamps success. What it cannot
  // report is a request that never reached it, or that it refused before
  // running: those close the run here, guarded so a row the route already
  // settled is left alone. Nothing is announced from here for this draft.
  const draft = sent.request.then(
    async (res) => {
      if (res.ok) return;
      await stampRun(
        supabase,
        runId,
        { phase: "drafting", status: "failed", detail: `The draft could not be started (${res.status}).` },
        { finish: true },
      );
    },
    async (err: unknown) => {
      await stampRun(
        supabase,
        runId,
        { phase: "drafting", status: "failed", detail: `The draft could not be started: ${err instanceof Error ? err.message : String(err)}` },
        { finish: true },
      );
    },
  );

  return {
    outcome: "awaiting-draft",
    keepAlive: Promise.all([draft, result.fanOutSettled, tail]).then(() => undefined, () => undefined),
  };
}
