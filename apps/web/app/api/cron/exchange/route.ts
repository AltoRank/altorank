import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { observedCron } from "@/lib/observability/cron";

/**
 * Daily cron: the exchange's janitor. Two jobs, nothing else:
 *
 * - expire requests nobody claimed before their `expires_at`;
 * - release a claim whose draft never arrived. Hosting a request claims it
 *   (`accepted`) and writes the draft after the response
 *   (app/actions/exchange.ts); a failure there releases the claim, but a
 *   function killed mid-generation never reaches its catch, and the request
 *   sat claimed by a host that would never deliver. After
 *   STALE_CLAIM_MS with no draft attached, it goes back to `requested`.
 *
 * It deliberately does NOT auto-place links or auto-verify/auto-pay credits:
 * placing a link mutates a provider's published article content and must be an
 * explicit human action (placeExchange), and credit transfer must follow a real
 * verification (verifyExchange), not a timer.
 */
/**
 * How long a claim may wait for its draft. A draft takes a few minutes and
 * the function writing it is cut off well inside this, so a claim this old
 * with no draft is one nothing is still working on.
 */
const STALE_CLAIM_MS = 60 * 60 * 1000;

async function run(request: Request) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
 * Cron requests carry no cookies, so the cookie-bound client authenticates as
 * nobody and RLS answers every query with an empty set. That is not an error,
 * so this route reported `success` with a zero count and had never processed a
 * single row. A cron has no user by definition: it must hold the service role.
 */
  const supabase = createServiceClient();
  const now = Date.now();

  // Claims first, so a released request past its date expires in the same run.
  const { data: released, error: releaseError } = await supabase
    .from("backlink_exchanges")
    .update({ provider_account_id: null, provider_workspace_id: null, status: "requested", matched_at: null })
    .eq("status", "accepted")
    .is("provider_article_id", null)
    .lt("matched_at", new Date(now - STALE_CLAIM_MS).toISOString())
    .select("id");
  if (releaseError) {
    return NextResponse.json({ error: releaseError.message }, { status: 500 });
  }

  // Nothing writes the old `matched` status; `requested` is the only open one.
  const { data: expired, error } = await supabase
    .from("backlink_exchanges")
    .update({ status: "expired" })
    .eq("status", "requested")
    .lt("expires_at", new Date(now).toISOString())
    .select("id");

  // `expired: 0` has to mean "nothing was due", never "the update never ran".
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    released: released?.length ?? 0,
    expired: expired?.length ?? 0,
  });
}

/**
 * Every run of this job lands in `system_events` (lib/observability/cron.ts):
 * a throw or a 5xx as an error, per-item failures as a warning, and a clean
 * run as one `info` row — which is the only thing anywhere that proves the
 * schedule is still firing.
 */
export const GET = observedCron("cron.exchange", run);
