// ---------------------------------------------------------------------------
// Whether a provider-down first look may be tried again without the person
// ---------------------------------------------------------------------------
//
// Asked by the overnight retry (./provider-retry.ts) before it starts a run,
// and by the setup-failed email (./run-store.ts) and the setup screen before
// either promises one, so the promise and the retry cannot disagree. Its own
// module so the run store can ask it without importing the retry, which
// imports the run store.

import type { SupabaseClient } from "@supabase/supabase-js";
import { canSpend } from "@/lib/billing/spend-gate";
import { planHoldApplies } from "@/lib/billing/trial-hold";

/**
 * Before the trial, and the spend gate would start setup for this site: the
 * same question /api/onboard/start asks, which counts the account's
 * pre-trial runs (PRE_TRIAL_SETUP_RUNS) and refuses once the first article
 * has been attempted.
 */
export async function providerRetryAllowed(supabase: SupabaseClient, accountId: string, workspaceId: string): Promise<boolean> {
  if (!(await planHoldApplies(supabase, workspaceId))) return false;
  const gate = await canSpend(supabase, accountId, { userEmail: null, workspaceId, action: "setup" });
  return gate.allowed;
}

