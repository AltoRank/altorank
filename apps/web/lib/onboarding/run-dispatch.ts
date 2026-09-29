// ---------------------------------------------------------------------------
// Getting a run out of the request that started it
// ---------------------------------------------------------------------------
//
// /api/onboard/start calls this from `after()`: the browser already has its
// runId and is polling the row, and this hands the work to /api/onboard/run
// in its own invocation - the same self-invocation the fan-out uses, with
// CRON_SECRET. An install that cannot self-invoke (no secret, no base URL)
// runs the worker right here instead, still inside after(), so the person
// still gets a run; it is just bounded by this function's budget rather than
// its own.
//
// This does not own the run's lifetime. The worker claims the row and answers
// 202 before it starts the pipeline, so what this waits for is the claim, not
// the minutes of work. It used to await the whole run: past 300 s Node's fetch
// gave up waiting for headers, and this stored "The run could not be started:
// fetch failed" and sent the setup-failed email while the worker was still
// going (a local run on 2026-09-28 finished at 5:00 and was recorded as
// failed). When the hand-off fails it closes the run only if no worker claimed
// it; a claimed run is the worker's to finish, and the reaper's if the worker
// dies.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { selfInvocation, selfInvoke, type SelfInvokeDeps } from "@/lib/content/fan-out";
import { executeRun } from "./run-worker";
import { failRun } from "./run-store";

export interface DispatchDeps extends SelfInvokeDeps {
  supabase?: SupabaseClient;
  execute?: typeof executeRun;
}

export async function dispatchWorker(runId: string, deps: DispatchDeps = {}): Promise<void> {
  const how = selfInvocation(deps);
  if ("skipped" in how) {
    const result = await (deps.execute ?? executeRun)(runId, deps.supabase ? { supabase: deps.supabase } : {});
    await result.keepAlive;
    return;
  }

  const supabase = () => deps.supabase ?? createServiceClient();
  try {
    const res = await selfInvoke("/api/onboard/run", { runId }, how);
    // 202 is the worker holding the claim; 409 is another worker holding it,
    // or the run already over. Neither is this dispatch's to judge.
    if (res.ok || res.status === 409) return;
    await failRun(supabase(), runId, `The run could not be started (${res.status}).`, { unclaimedOnly: true });
  } catch (err) {
    await failRun(
      supabase(),
      runId,
      `The run could not be started: ${err instanceof Error ? err.message : String(err)}`,
      { unclaimedOnly: true },
    );
  }
}
