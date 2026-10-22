// ---------------------------------------------------------------------------
// A completed checkout, recorded on the account once, whoever gets there first
// ---------------------------------------------------------------------------
//
// Two doors reach this: Stripe's `checkout.session.completed` webhook, and the
// page the buyer comes back to (/api/billing/checkout-status). The page used
// to only wait for the webhook, so a webhook that was late, misconfigured or
// failing left the buyer on the free plan, told "taking longer than
// expected", while Stripe held a trialing subscription that charges on day
// eight. Now whichever door arrives first records the checkout, and the other
// finds nothing left to do.
//
// Nothing here is written twice, including when both doors run at once:
//
//   the account   one conditional update, applied only while the account does
//                 not already carry this subscription. Postgres re-checks the
//                 condition once a concurrent writer commits, so the second
//                 writer matches no row.
//   the pace      compare-and-set on the value that was read, so a site is
//                 raised once
//   the follow-up `oweResume` owes a site once per subscription, and only the
//                 call that owed it hands the work off
//   the email     `sendOnce`, keyed by account and subscription
//   the funnel    `recordTrialStarted`, keyed by site
//
// The account write is not a claim on everything after it. Stripe does not
// order `customer.subscription.created` against the checkout, and that event
// writes the same ids; and a delivery whose later step failed is delivered
// again. In both cases the account already carries the subscription while the
// sites are still owed their follow-up. So every step after the write runs
// every time, and each one is a no-op once it is done.

import { after } from "next/server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getStripe,
  intervalForSubscription,
  isSelfServePlan,
  planChargeLabel,
  planForPriceId,
  PLAN_LABELS,
  type SelfServePlan,
} from "@/lib/stripe";
import { paceOnActivation } from "@/lib/content/pace";
import { canSelfInvoke } from "@/lib/content/fan-out";
import { oweResume } from "@/lib/plan/resume-week";
import { dispatchResume } from "@/lib/plan/resume-dispatch";
import { recordTrialStarted } from "@/lib/onboarding/step-events";
import { notifyTrialStarted } from "@/lib/email/lifecycle";

/** One Stripe read on the way to an answer: long enough for a slow one, short enough to retry. */
export const STRIPE_READ_TIMEOUT_MS = 8_000;

/**
 * The subscription a checkout created, read from Stripe.
 *
 * Thrown on failure rather than answered with a guess. A failed read used to
 * mean "no trial": the checkout was written as a paid `active` plan with no
 * trial end, and the rest of the week was never drafted. The webhook answers
 * 500 and Stripe delivers the event again; the return page answers 503 and
 * polls again. Bounded, so one slow read stays inside Stripe's own wait for
 * the webhook rather than the SDK's 80 s default.
 */
export async function readCheckoutSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  try {
    return await getStripe().subscriptions.retrieve(subscriptionId, {}, { timeout: STRIPE_READ_TIMEOUT_MS, maxNetworkRetries: 1 });
  } catch (err) {
    throw new Error(`could not read subscription ${subscriptionId} to tell a trial from a paid plan (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** `trial_end` as ISO when the subscription is trialing, else null. */
export function trialEndOf(sub: Stripe.Subscription): string | null {
  if (sub.status !== "trialing" || !sub.trial_end) return null;
  return new Date(sub.trial_end * 1000).toISOString();
}

/**
 * Which tier a subscription is on: the price first, the metadata hint second.
 *
 * The price is what Stripe bills, so it is the answer. The hint is the `plan`
 * our checkout wrote on the session and the subscription, read only when the
 * price is not one this deployment sells. `hints` is the session's metadata,
 * under the subscription's own.
 *
 * This exists because the checkout used to write the ids and the status and
 * *not* `plan`. `accounts.plan` is `not null default 'starter'`, so a EUR 199
 * Agency buyer sat on Managed's row, metered at 100 articles instead of 400,
 * until some later subscription event happened to correct it (2026-09-06).
 */
export function planForSubscription(sub: Stripe.Subscription, hints?: Stripe.Metadata | null): SelfServePlan | undefined {
  const fromPrice = planForPriceId(sub.items?.data?.[0]?.price?.id);
  if (fromPrice) return fromPrice;
  for (const hint of [sub.metadata?.plan, hints?.plan]) if (isSelfServePlan(hint)) return hint;
  return undefined;
}

/** The account as the return page reads it. */
export type CheckoutAccount = { stripe_subscription_id: string | null; plan_status: string | null; trial_ends_at: string | null };

/** A status under which the account already pays for (or trials) a plan that a checkout must not replace. */
const LIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

/**
 * The subscription the return page should record itself rather than wait for
 * Stripe's webhook, or null: the session is complete, it made a subscription,
 * and the account carries neither that subscription nor another one still
 * live. A returning customer whose old plan ended is recorded; a session from
 * an earlier purchase never replaces the plan the account has now.
 */
export function awaitingActivation(session: Stripe.Checkout.Session, account: CheckoutAccount | null): string | null {
  const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (session.status !== "complete" || !subscription || !account) return null;
  if (account.stripe_subscription_id === subscription) return null;
  if (account.stripe_subscription_id && LIVE_STATUSES.has(account.plan_status ?? "")) return null;
  return subscription;
}

export interface CompletedCheckout {
  accountId: string;
  customerId: string;
  /** The subscription the checkout created, as Stripe has it now: never the session's word for it. */
  subscription: Stripe.Subscription;
  /** The session's metadata: the tier and interval our checkout wrote, read under the subscription's own. */
  hints?: Stripe.Metadata | null;
}

export interface ActivationOutcome {
  /** This call's write put the subscription on the account. False when it was already there. */
  recorded: boolean;
  trialEndsAt: string | null;
  plan: SelfServePlan | undefined;
  /** Sites this call raised to the plan's pace. */
  paced: number;
  /** Sites this call newly owed the checkout's follow-up. */
  owed: number;
}

/**
 * Record a completed checkout on the account and start what it opens.
 *
 * Throws when a write fails, before anything that depends on it: the webhook
 * answers 500 and Stripe delivers the event again; the return page answers
 * 503 and asks again. The handoffs (`dispatchResume`, `recordTrialStarted`)
 * run in `after()`, once the caller has answered.
 */
export async function activateCheckout(supabase: SupabaseClient, checkout: CompletedCheckout): Promise<ActivationOutcome> {
  const { accountId, customerId, subscription: sub, hints } = checkout;
  const subscriptionId = sub.id;
  const plan = planForSubscription(sub, hints);
  const trial = trialEndOf(sub);

  // Written only while the account does not carry this subscription yet, or
  // carries it without a status (`customer.subscription.created` writes the
  // ids of a subscription that is still `incomplete` and leaves the status to
  // `updated`). An account already recorded for this checkout is not touched:
  // a second door at the same moment matches no row, and a delivery days
  // late cannot put a cancelled trial back to `trialing`.
  const { data: written, error: accountWriteError } = await supabase
    .from("accounts")
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      // A checkout that opened a trial is `trialing`, not paid: the card is
      // held and the first charge is on day eight. Writing `active` here (the
      // rule until 2026-09-09) showed a trial as a paid plan and never counted
      // it as the account's one trial.
      plan_status: trial ? "trialing" : "active",
      ...(trial ? { trial_ends_at: trial } : {}),
      // Omitted only when neither the price nor the hint is a plan we sell;
      // the later subscription event is then the last line of defence.
      ...(plan ? { plan } : {}),
    })
    .eq("id", accountId)
    .or(`stripe_subscription_id.is.null,stripe_subscription_id.neq.${subscriptionId},plan_status.eq.inactive`)
    .select("id");
  // Checked, and thrown. Everything below acts on this write: a resume
  // dispatched against an account this write missed drafts nothing, records
  // "waiting for your trial to start" on every owed entry, and spends the
  // checkout's one burst.
  if (accountWriteError) {
    throw new Error(`could not record the subscription on the account (${accountWriteError.message})`);
  }

  /**
   * Start writing at a paid pace.
   *
   * Signup sets FREE_TIER_PACE, which is right while the account is free. It
   * used to set one a week against a one-draft month, and nothing raised it
   * afterwards, so a customer who paid for 100 a month kept getting about
   * four. `paceOnActivation` only ever raises, and only from a value the
   * product itself chose. Compare-and-set on the value read, so two doors at
   * once raise a site once; a site somebody changed in between is left alone.
   *
   * Both checked: a failed read left the sites at the free pace and the email
   * saying the week was not handed off, and a failed write left one site at
   * the free pace, each under a 200.
   */
  const { data: sites, error: sitesError } = await supabase
    .from("workspaces")
    .select("id, auto_generate_weekly_limit, auto_generate, status")
    .eq("account_id", accountId);
  if (sitesError) throw new Error(`could not read the account's sites (${sitesError.message})`);
  let paced = 0;
  for (const site of sites ?? []) {
    const current = site.auto_generate_weekly_limit as number | null;
    const next = paceOnActivation(current, plan);
    if (next === null) continue;
    const raise = supabase.from("workspaces").update({ auto_generate_weekly_limit: next }).eq("id", site.id);
    const { data: raised, error: paceError } = await (current === null || current === undefined
      ? raise.is("auto_generate_weekly_limit", null)
      : raise.eq("auto_generate_weekly_limit", current)
    ).select("id");
    if (paceError) throw new Error(`could not raise a site to the plan's pace (${paceError.message})`);
    paced += (raised ?? []).length;
  }

  /**
   * Open what the trial gate held back, off this request.
   *
   * A gated account has its one article and nothing else
   * (lib/billing/trial-hold.ts). The trial lifts that, and the person comes
   * back to a dashboard that should fill while they look around: the month
   * on the calendar, and the rest of this week being written now.
   *
   * Neither is done here; both run for minutes. What this does is write down
   * that every site is owed this checkout's follow-up (`oweResume`, keyed by
   * the subscription), and hand the work to /api/internal/resume-drafting
   * once the caller has answered (lib/plan/resume-dispatch.ts). Only the call
   * that owed a site hands it off: a second door finds nothing newly owed. A
   * hand-off that is lost leaves the sites owed, and the scheduled writer's
   * next run sends it again (lib/plan/resume-sweep.ts). A checkout without a
   * trial gets the top-up only; its drafts come at the scheduled pace.
   */
  const owed = await oweResume(supabase, accountId, subscriptionId);
  if (owed > 0) {
    const resume = { accountId, key: subscriptionId, draftWeek: Boolean(trial) };
    after(() => dispatchResume(resume));
  }

  // The card was taken: say when it is charged and where to stop that. And,
  // when it is true at the moment this is sent, that the rest of this week has
  // gone to the writer: a trial checkout, an install that can hand the drafts
  // off, and a site set to write automatically and not paused. Whether each
  // draft then lands is not known yet, so the email promises the hand-off,
  // not the drafts.
  if (trial) {
    // The funnel's trial (onboarding.step): Stripe's subscription is the
    // fact, whichever door read it. After the answer, like the resume.
    const workspaceIds = (sites ?? []).map((s) => s.id as string);
    after(() => recordTrialStarted(supabase, { accountId, workspaceIds, plan }));
    const tier = plan ?? "starter";
    const weekHandedOff =
      canSelfInvoke() && (sites ?? []).some((s) => s.auto_generate === true && s.status !== "paused");
    try {
      // The amount the card is charged on day eight: the yearly price for a
      // yearly trial, which used to be quoted the monthly one.
      const interval = intervalForSubscription({ items: sub.items, metadata: { ...(hints ?? {}), ...(sub.metadata ?? {}) } });
      await notifyTrialStarted(
        supabase,
        accountId,
        { planLabel: PLAN_LABELS[tier] ?? tier, planPrice: planChargeLabel(tier, interval), endsAt: trial, weekHandedOff },
        subscriptionId,
      );
    } catch (err) {
      console.error(`[billing] trial-started email: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { recorded: (written ?? []).length > 0, trialEndsAt: trial, plan, paced, owed };
}
