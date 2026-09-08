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
import { runOnboarding } from "./pipeline";
import { RunRecorder, RUN_COLUMNS, stampRun } from "./run-store";
import type { OnboardingRunRow } from "./events";

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
   * Requests this run fired and did not wait for: the first draft, the
   * fan-out. Never rejects. The route hands it to `after()` so the function
   * is not frozen with them still in its socket buffer.
   */
  keepAlive: Promise<void>;
}

export interface ExecuteDeps {
  supabase?: SupabaseClient;
  run?: typeof runOnboarding;
  dispatch?: typeof dispatchFirstDraft;
  canDispatch?: () => boolean;
}

interface WorkerWorkspace {
  id: string;
  domain: string | null;
  agency_id: string;
  language: string | null;
  location_code: number | null;
  auto_generate_weekly_limit: number | null;
  /** Seeds the keyword phase from the business, not only from page headings. */
  business_profile?: unknown;
}

export async function executeRun(runId: string, deps: ExecuteDeps = {}): Promise<ExecuteResult> {
  const supabase = deps.supabase ?? createServiceClient();
  const settled = { outcome: "failed" as ExecuteOutcome, keepAlive: Promise.resolve() };

  const { data: found } = await supabase.from("onboarding_runs").select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  const run = found as OnboardingRunRow | null;
  if (!run) return { ...settled, outcome: "not-found" };
  if (run.status !== "running") return { ...settled, outcome: "already-finished" };

  // Claim it. A run is dispatched once, but a retried dispatch or a start
  // that raced could send two workers; the second finds `phases` no longer
  // empty and leaves. Atomic in the update's WHERE, so both cannot pass.
  const { data: claimed } = await supabase
    .from("onboarding_runs")
    .update({ phases: [{ phase: "scanning", status: "pending" }], updated_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "running")
    .eq("phases", "[]")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { ...settled, outcome: "already-running" };

  const recorder = new RunRecorder(supabase, runId);

  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, domain, agency_id, language, location_code, auto_generate_weekly_limit, business_profile")
    .eq("id", run.workspace_id)
    .maybeSingle();
  const workspace = ws as WorkerWorkspace | null;
  if (!workspace) {
    await recorder.fail("The workspace no longer exists.");
    return settled;
  }

  const canDispatch = (deps.canDispatch ?? canSelfInvoke)();
  let result: Awaited<ReturnType<typeof runOnboarding>>;
  try {
    result = await (deps.run ?? runOnboarding)(supabase, workspace, recorder.record, {
      firstDraft: canDispatch ? "dispatch" : "inline",
    });
  } catch (err) {
    await recorder.fail(err instanceof Error ? err.message : "Onboarding failed.");
    return settled;
  }
  // Every phase is on the row before anything else may write to it.
  await recorder.flush();

  const pending = result.pendingDraft;
  if (!pending) {
    await recorder.finish();
    return { outcome: "ran", keepAlive: result.fanOutSettled };
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
  });
  if ("skipped" in sent) {
    // canSelfInvoke said yes a moment ago; only an env change between the
    // two calls gets here. Close the run honestly rather than leave it
    // spinning for a draft nobody will write.
    await stampRun(supabase, runId, { phase: "drafting", status: "failed", detail: "The draft could not be started on this install." }, { finish: true });
    return { outcome: "failed", keepAlive: result.fanOutSettled };
  }

  // The draft route stamps the row itself, on success and on its own
  // failures. What it cannot report is a request that never reached it, or
  // that it refused before running: those close the run here, guarded so a
  // row the route already settled is left alone.
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
    keepAlive: Promise.all([draft, result.fanOutSettled]).then(() => undefined),
  };
}
