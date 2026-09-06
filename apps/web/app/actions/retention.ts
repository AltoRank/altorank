"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { billingEnabled, getStripe } from "@/lib/stripe";
import { isPauseMonths, pausedUntil, resumesAtUnix } from "@/lib/billing/pause";
import { liftStripePause, resumePausedWorkspaces } from "@/lib/billing/resume";
import { validateCancellation } from "@/lib/billing/cancellation";
import { billingFailure, type BillingOutcome } from "@/lib/billing/failure";

// Pause, resume, cancel, keep. Owner only, like checkout and the portal:
// these change what the account pays. Each one writes our own rows first and
// tells Stripe second, so a Stripe failure leaves a visible, resumable state
// rather than a silent disagreement.
//
// All four return a result rather than throwing: Next.js digests a thrown
// server-action message in production, so a refused pause or cancellation
// reached the person as a hex string. See lib/billing/failure.ts.

async function ownerAgency() {
  const { agencyId, user } = await requireAuth(["owner"]);
  const supabase = await createClient();
  const { data: agency } = await supabase
    .from("agencies")
    .select("id, plan, stripe_subscription_id, current_period_end")
    .eq("id", agencyId)
    .single();
  if (!agency) throw new Error("No account found.");
  return { supabase, agency, user };
}

/**
 * Pause for 1, 2 or 3 months. Every workspace on the account goes to
 * `paused` with the same end date, which stops the generate, analyze and
 * site-pages crons. With a subscription, Stripe stops collecting until the
 * same date (`pause_collection`, invoices voided rather than accumulated).
 */
export async function pauseAccount(months: unknown): Promise<BillingOutcome<{ pausedUntil: string }>> {
  if (!isPauseMonths(months)) return { ok: false, error: "Choose 1, 2 or 3 months." };
  const { supabase, agency } = await ownerAgency();
  const until = pausedUntil(new Date(), months);

  const { error } = await supabase
    .from("workspaces")
    .update({ status: "paused", paused_until: until })
    .eq("agency_id", agency.id)
    .neq("status", "paused");
  if (error) return billingFailure(error, "The sites could not be paused");

  if (billingEnabled && agency.stripe_subscription_id) {
    try {
      await getStripe().subscriptions.update(agency.stripe_subscription_id, {
        pause_collection: { behavior: "void", resumes_at: resumesAtUnix(until) },
      });
    } catch (err) {
      // The rows are already paused, so writing stopped; only the billing half
      // failed, and saying "paused" would be a claim about money we did not
      // make. Named as the half that did not happen, with the state that did.
      console.error("[billing] pause: Stripe refused", err);
      return {
        ok: false,
        error:
          "Writing is paused for every site, but billing could not be paused with it — you may still be charged for the next renewal. Try again in a moment, or email hello@altorank.co.",
      };
    }
  }

  revalidatePath("/settings/billing");
  revalidatePath("/dashboard");
  return { ok: true, pausedUntil: until };
}

/**
 * Resume. Only workspaces this pause set are touched: a row paused by hand
 * (`paused_until` null) stays as its owner left it. Resumed sites go back to
 * publishing; a site that was still in setup would also have been in setup
 * when it was paused, and `on` is what activation would set.
 *
 * The same write the generate cron makes on its own once `paused_until` has
 * passed, and the webhook makes when Stripe reports the pause lifted
 * (lib/billing/resume.ts). This button is for ending the pause early.
 */
export async function resumeAccount(): Promise<BillingOutcome> {
  const { supabase, agency } = await ownerAgency();

  try {
    await resumePausedWorkspaces(supabase, agency.id);
  } catch (err) {
    return billingFailure(err, "The sites could not be resumed");
  }

  if (billingEnabled && agency.stripe_subscription_id) {
    try {
      await liftStripePause(getStripe(), agency.stripe_subscription_id);
    } catch (err) {
      // Writing is back either way; Stripe resumes on `resumes_at` by itself,
      // and the generate cron lifts the rows again if it has to
      // (lib/billing/resume.ts). Worth saying, not worth undoing.
      console.error("[billing] resume: Stripe refused", err);
      return {
        ok: false,
        error:
          "Writing has resumed for every site, but billing could not be restarted with it. It restarts on its own at the end of the pause; email hello@altorank.co if the plan still looks paused tomorrow.",
      };
    }
  }

  revalidatePath("/settings/billing");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Cancel at period end, after the survey. The feedback row is written first
 * and stays even if Stripe refuses; the subscription is then told to stop
 * renewing and `agencies.cancels_at` records the date the page has to state.
 * Nothing about the workspaces changes: access continues to that date, and
 * the articles stay readable and exportable afterwards.
 */
export async function cancelPlan(answers: {
  reason: string;
  detail?: string;
}): Promise<BillingOutcome<{ cancelsAt: string | null }>> {
  const v = validateCancellation(answers);
  if (!v.ok) return { ok: false, error: v.error };
  const { supabase, agency, user } = await ownerAgency();

  if (!agency.stripe_subscription_id) {
    return { ok: false, error: "There is no active subscription to cancel." };
  }

  // The reason is written before Stripe is told, so the one thing a
  // cancellation teaches us survives a Stripe refusal. `completed_at` records
  // whether the cancellation the reason belongs to actually went through, so
  // a retry does not read as two people leaving.
  const { data: feedback, error: fbError } = await supabase
    .from("cancellation_feedback")
    .insert({
      agency_id: agency.id,
      user_id: user.id,
      reason: v.reason,
      detail: v.detail,
      plan: agency.plan,
    })
    .select("id")
    .single();
  if (fbError) return billingFailure(fbError, "The cancellation could not be recorded");

  let cancelsAt: string | null = agency.current_period_end ?? null;
  if (billingEnabled) {
    try {
      const sub = await getStripe().subscriptions.update(agency.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
      if (sub.cancel_at) cancelsAt = new Date(sub.cancel_at * 1000).toISOString();
    } catch (err) {
      // Nothing has changed: the subscription still renews. The survey row
      // stays - the answer is worth keeping - but it is not a cancellation,
      // and the page must not say it was.
      console.error(`[billing] cancel: Stripe refused (feedback ${feedback?.id})`, err);
      return {
        ok: false,
        error:
          "Your plan has not been cancelled — the payment provider did not accept the change, and it will renew as before. Nothing else is affected. Try again in a moment, or email hello@altorank.co.",
      };
    }
  }

  const { error } = await supabase.from("agencies").update({ cancels_at: cancelsAt }).eq("id", agency.id);
  if (error) return billingFailure(error, "The cancellation date could not be saved");

  revalidatePath("/settings/billing");
  return { ok: true, cancelsAt };
}

/** Undo a pending cancellation. The plan renews as before. */
export async function keepPlan(): Promise<BillingOutcome> {
  const { supabase, agency } = await ownerAgency();
  if (billingEnabled && agency.stripe_subscription_id) {
    try {
      await getStripe().subscriptions.update(agency.stripe_subscription_id, { cancel_at_period_end: false });
    } catch (err) {
      // Stripe still holds the cancellation, so clearing `cancels_at` here
      // would hide a plan that really is ending.
      return billingFailure(err, "The cancellation could not be undone");
    }
  }
  const { error } = await supabase.from("agencies").update({ cancels_at: null }).eq("id", agency.id);
  if (error) return billingFailure(error, "The cancellation could not be undone");
  revalidatePath("/settings/billing");
  return { ok: true };
}
