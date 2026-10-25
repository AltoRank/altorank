// ---------------------------------------------------------------------------
// Publishing needs a plan, wherever the publish starts
// ---------------------------------------------------------------------------
//
// Approve asks for a plan (lib/articles/approve.ts) and so does the Publish
// button (app/actions/publish.ts), but an article approved and scheduled
// while the plan was on stays `scheduled` after it ends, and cron/publish
// sent it out: a trial that ended or was cancelled, a first charge that
// failed, a paid plan that lapsed. The publisher only asked the pre-trial
// body gate (assessment 2026-10-25). Sending an article to somebody's site is
// what the plan pays for, so the publisher asks here too, for every caller.

import type { SupabaseClient } from "@supabase/supabase-js";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";

/**
 * Thrown by the publisher when the site's account holds no entitled plan.
 * A class of its own so the cron can leave the article scheduled - it ships
 * when the plan comes back - instead of marking it failed.
 */
export class PlanRequiredError extends Error {
  constructor(message: string = CHOOSE_PLAN_MESSAGE) {
    super(message);
    this.name = "PlanRequiredError";
  }
}

/**
 * Whether the account that owns this site needs a plan before anything is
 * published for it. Asked as nobody (`null`): the cron has no session, and
 * the operator bypass is resolved from the account (lib/billing/quota.ts).
 * A site whose account cannot be read throws - an unknown is not a plan.
 */
export async function siteNeedsPlanToPublish(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`publish: could not read the site's account (${error.message})`);
  if (!data?.account_id) throw new Error("publish: this site has no account");
  return needsPlanToShip(supabase, data.account_id as string, null);
}
