// ---------------------------------------------------------------------------
// Lifting the account pause: the one write, from every door
// ---------------------------------------------------------------------------
//
// The account pause on Billing writes `status = 'paused', paused_until = D`
// on every workspace and tells Stripe to stop collecting until D
// (`pause_collection.resumes_at`). Stripe keeps its side of that date on its
// own: on D it starts charging again. Our side did not - the workspaces
// stayed paused until a human pressed "Resume now", so a customer who paused
// for a month and forgot was billed for a month in which nothing was drafted
// (2026-09-06).
//
// Three doors now lift the pause, and they share this write:
//
//   the Resume button        app/actions/retention.ts, rows then Stripe
//   the generate cron        `resumeExpiredPauses`, every run, for every
//                            agency whose date has passed
//   the Stripe webhook       `customer.subscription.updated` reporting
//                            `pause_collection` cleared, rows only
//
// Only rows this pause set are touched: a site paused by hand carries no
// `paused_until` and stays as its owner left it. Resumed sites go to `on`,
// which is what activation would set and what the Resume button always did.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

/** YYYY-MM-DD in UTC, the format `paused_until` is stored in. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Put every billing-paused workspace of the agency back to `on`. Returns
 * the ids resumed; empty when nothing was paused by the account pause.
 */
export async function resumePausedWorkspaces(
  supabase: SupabaseClient,
  agencyId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("workspaces")
    .update({ status: "on", paused_until: null })
    .eq("agency_id", agencyId)
    .eq("status", "paused")
    .not("paused_until", "is", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id as string);
}

/**
 * Tell Stripe to collect again. Idempotent: clearing `pause_collection` on a
 * subscription that is not paused is a no-op on Stripe's side, so the cron
 * can call it after Stripe's own `resumes_at` has already fired.
 */
export async function liftStripePause(stripe: Stripe, subscriptionId: string): Promise<void> {
  await stripe.subscriptions.update(subscriptionId, { pause_collection: "" });
}

export type ExpiredPauseOutcome = {
  agencyId: string;
  workspaces: string[];
  /** "lifted", "skipped" (no subscription), or the Stripe error message. */
  stripe: string;
};

/**
 * Resume every agency whose pause date has passed. Runs from the generate
 * cron ahead of picking work, so a site whose month is up is back in the
 * queue on the same run rather than a day later.
 *
 * The rows are written first and Stripe second, per agency, and a Stripe
 * refusal is reported rather than thrown: by the time this runs Stripe has
 * normally resumed on its own, and the write that matters - the one that
 * makes the crons see the site again - is already done.
 */
export async function resumeExpiredPauses(
  supabase: SupabaseClient,
  stripe: Stripe | null,
  today: Date = new Date(),
): Promise<ExpiredPauseOutcome[]> {
  const { data: due, error } = await supabase
    .from("workspaces")
    .select("agency_id")
    .eq("status", "paused")
    .not("paused_until", "is", null)
    .lte("paused_until", isoDay(today));
  if (error) throw new Error(error.message);

  const agencies = [...new Set((due ?? []).map((r) => r.agency_id as string))];
  const outcomes: ExpiredPauseOutcome[] = [];

  for (const agencyId of agencies) {
    const workspaces = await resumePausedWorkspaces(supabase, agencyId);
    let stripeOutcome = "skipped";
    if (stripe) {
      const { data: agency } = await supabase
        .from("agencies")
        .select("stripe_subscription_id")
        .eq("id", agencyId)
        .single();
      const subscriptionId = agency?.stripe_subscription_id as string | null | undefined;
      if (subscriptionId) {
        try {
          await liftStripePause(stripe, subscriptionId);
          stripeOutcome = "lifted";
        } catch (err) {
          stripeOutcome = err instanceof Error ? err.message : "stripe error";
        }
      }
    }
    outcomes.push({ agencyId, workspaces, stripe: stripeOutcome });
  }
  return outcomes;
}
