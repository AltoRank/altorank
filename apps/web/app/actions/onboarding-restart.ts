"use server";

// ---------------------------------------------------------------------------
// "Wrong? Fix it and start over" (lib/onboarding/stop-to-change.ts)
// ---------------------------------------------------------------------------
//
// The panel beside a live first look offers to stop it while it is still
// reading the site, so its owner can change what it was started on. The run
// screen asks `mayStartSetupOver` once the run exists, and the link calls
// `stopSetupToChange`; the next run starts from "Change what we found" through
// /api/onboard/start and the same gate. Kept apart from onboarding-wizard.ts:
// stopping reads the run store, and the wizard's own actions have no reason
// to load it.

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { canSpend } from "@/lib/billing/spend-gate";
import { refusedWhileViewingAs } from "@/lib/auth/impersonation";
import { stopRunToChange } from "@/lib/onboarding/run-store";
import { TOO_LATE_TO_STOP } from "@/lib/onboarding/stop-to-change";

/**
 * Why the run on screen may not be stopped and started over, or null when it
 * may: the owner's call (the one who answers for the card, as with the gate's
 * other "Change what we found" doors), not while an operator is viewing as
 * the account, and only when the spend gate would start one more setup run.
 * Asked while the run exists, so PRE_TRIAL_SETUP_RUNS counts it: the answer
 * is about the run after this one, the one a restart would start.
 */
async function startOverRefusal(workspaceId: string, runId: string): Promise<string | null> {
  const viewing = await refusedWhileViewingAs("Setting up the site");
  if (viewing) return viewing;
  const { accountId, user, role } = await requireAuth(undefined, { workspaceId });
  if (role !== "owner") return "Only the account owner can start setup over.";
  const supabase = await createClient();
  // Through the person's own client: RLS decides whether they can see it.
  const { data: run, error } = await supabase
    .from("onboarding_runs")
    .select("id, status")
    .eq("id", runId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the setup run: ${error.message}`);
  if (!run) return "That setup run is not on this site.";
  if (run.status !== "running") return "This setup has already ended.";
  const gate = await canSpend(supabase, accountId, { userEmail: user.email ?? undefined, workspaceId, action: "setup" });
  return gate.allowed ? null : gate.message;
}

/**
 * Whether the run screen may offer to stop this run and start over. Asked
 * once per run, after the run exists. Never throws: an answer it could not
 * get is no, and the link stays hidden.
 */
export async function mayStartSetupOver(workspaceId: string, runId: string): Promise<boolean> {
  try {
    return (await startOverRefusal(workspaceId, runId)) === null;
  } catch {
    return false;
  }
}

export type StopSetupResult = { ok: true } | { ok: false; message: string };

/**
 * Stop the live run so its owner can change what it was started on. Returned,
 * never thrown: a thrown message reaches the browser as a digest in
 * production.
 */
export async function stopSetupToChange(workspaceId: string, runId: string): Promise<StopSetupResult> {
  try {
    const refused = await startOverRefusal(workspaceId, runId);
    if (refused) return { ok: false, message: refused };
    const result = await stopRunToChange(createServiceClient(), runId, workspaceId);
    if (result.stopped) {
      revalidatePath("/onboarding");
      return { ok: true };
    }
    return { ok: false, message: result.reason === "too-late" ? TOO_LATE_TO_STOP : "This setup has already ended." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Could not stop setup. Try again." };
  }
}
