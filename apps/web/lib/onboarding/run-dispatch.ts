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
    // 409 is the worker saying the run is already claimed or finished, which
    // is not a failure of this dispatch. Anything else non-2xx never ran the
    // pipeline (a 5xx that did has already closed the row itself).
    if (!res.ok && res.status !== 409) {
      await failRun(supabase(), runId, `The run could not be started (${res.status}).`);
    }
  } catch (err) {
    await failRun(supabase(), runId, `The run could not be started: ${err instanceof Error ? err.message : String(err)}`);
  }
}
