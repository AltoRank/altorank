"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { billingEnabled, getStripe } from "@/lib/stripe";
import { isPauseMonths, pausedUntil, resumesAtUnix } from "@/lib/billing/pause";
import { validateCancellation } from "@/lib/billing/cancellation";

// Pause, resume, cancel, keep. Owner only, like checkout and the portal:
// these change what the account pays. Each one writes our own rows first and
// tells Stripe second, so a Stripe failure leaves a visible, resumable state
// rather than a silent disagreement.

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
export async function pauseAccount(months: unknown): Promise<{ pausedUntil: string }> {
  if (!isPauseMonths(months)) throw new Error("Choose 1, 2 or 3 months.");
  const { supabase, agency } = await ownerAgency();
  const until = pausedUntil(new Date(), months);

  const { error } = await supabase
    .from("workspaces")
    .update({ status: "paused", paused_until: until })
    .eq("agency_id", agency.id)
    .neq("status", "paused");
  if (error) throw new Error(error.message);

  if (billingEnabled && agency.stripe_subscription_id) {
    await getStripe().subscriptions.update(agency.stripe_subscription_id, {
      pause_collection: { behavior: "void", resumes_at: resumesAtUnix(until) },
    });
  }

  revalidatePath("/settings/billing");
  revalidatePath("/dashboard");
  return { pausedUntil: until };
}

/**
 * Resume. Only workspaces this pause set are touched: a row paused by hand
 * (`paused_until` null) stays as its owner left it. Resumed sites go back to
 * publishing; a site that was still in setup would also have been in setup
 * when it was paused, and `on` is what activation would set.
 */
export async function resumeAccount(): Promise<void> {
  const { supabase, agency } = await ownerAgency();

  const { error } = await supabase
    .from("workspaces")
    .update({ status: "on", paused_until: null })
    .eq("agency_id", agency.id)
    .eq("status", "paused")
    .not("paused_until", "is", null);
  if (error) throw new Error(error.message);

  if (billingEnabled && agency.stripe_subscription_id) {
    await getStripe().subscriptions.update(agency.stripe_subscription_id, { pause_collection: "" });
  }

  revalidatePath("/settings/billing");
  revalidatePath("/dashboard");
}

/**
 * Cancel at period end, after the survey. The feedback row is written first
 * and stays even if Stripe refuses; the subscription is then told to stop
 * renewing and `agencies.cancels_at` records the date the page has to state.
 * Nothing about the workspaces changes: access continues to that date, and
 * the articles stay readable and exportable afterwards.
 */
export async function cancelPlan(answers: { reason: string; detail?: string }): Promise<{ cancelsAt: string | null }> {
  const v = validateCancellation(answers);
  if (!v.ok) throw new Error(v.error);
  const { supabase, agency, user } = await ownerAgency();

  const { error: fbError } = await supabase.from("cancellation_feedback").insert({
    agency_id: agency.id,
    user_id: user.id,
    reason: v.reason,
    detail: v.detail,
    plan: agency.plan,
  });
  if (fbError) throw new Error(fbError.message);

  let cancelsAt: string | null = agency.current_period_end ?? null;
  if (billingEnabled && agency.stripe_subscription_id) {
    const sub = await getStripe().subscriptions.update(agency.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    if (sub.cancel_at) cancelsAt = new Date(sub.cancel_at * 1000).toISOString();
  } else if (!agency.stripe_subscription_id) {
    throw new Error("There is no active subscription to cancel.");
  }

  const { error } = await supabase.from("agencies").update({ cancels_at: cancelsAt }).eq("id", agency.id);
  if (error) throw new Error(error.message);

  revalidatePath("/settings/billing");
  return { cancelsAt };
}

/** Undo a pending cancellation. The plan renews as before. */
export async function keepPlan(): Promise<void> {
  const { supabase, agency } = await ownerAgency();
  if (billingEnabled && agency.stripe_subscription_id) {
    await getStripe().subscriptions.update(agency.stripe_subscription_id, { cancel_at_period_end: false });
  }
  const { error } = await supabase.from("agencies").update({ cancels_at: null }).eq("id", agency.id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings/billing");
}
