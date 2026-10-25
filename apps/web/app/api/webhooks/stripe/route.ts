import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  getStripe,
  planForPriceId,
  PLAN_ARTICLE_LIMITS,
  PLAN_LABELS,
  intervalForSubscription,
  planChargeLabel,
  type PlanTier,
} from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { recordEvent } from "@/lib/observability/record";
import { describe as describeError } from "@/lib/observability/event";
import { paceOnDowngrade } from "@/lib/plan/pace-options";
import { resumePausedWorkspaces } from "@/lib/billing/resume";
import { firstChargeFailed, graceEndsAt } from "@/lib/billing/dunning";
import { invoicePendingCharges, paymentMethodId } from "@/lib/billing/invoice-pending";
import {
  notifyPaymentFailed,
  notifyPlanChanged,
  notifySubscriptionCancelled,
  notifyTrialEnding,
} from "@/lib/email/lifecycle";
import { activateCheckout, planForSubscription, readCheckoutSubscription, trialEndOf } from "@/lib/billing/activate-checkout";
import type { SupabaseClient } from "@supabase/supabase-js";

function mapStatus(s: Stripe.Subscription.Status): string {
  switch (s) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
      return s;
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
      return "past_due";
    // Paused is not a failed payment: Stripe pauses a subscription when a
    // trial ends without a payment method, or when pause_collection is set
    // from the dashboard. Mapped to past_due (until 2026-09-07) it carried no
    // payment_failed_at, which dunningState reads as "lapsed", so the account
    // saw a red "Payment failed" banner for a card that never failed. Nothing
    // is being paid for, so the honest state is the one an account with no
    // subscription has.
    case "paused":
      return "inactive";
    default:
      return "inactive";
  }
}

/**
 * The checkout's follow-up is handed off in `after()`, and on an install that
 * cannot call itself it runs there (lib/plan/resume-dispatch.ts): the month's
 * top-up, which buys verdicts. The same budget cron/analyze and write-now use.
 */
export const maxDuration = 300;

type AccountBillingRow = {
  id: string;
  plan_status: string | null;
  payment_failed_at: string | null;
  /** For the emails: which tier they are on, and what to call the account. */
  plan?: string | null;
  name?: string | null;
  cancels_at?: string | null;
  trial_ends_at?: string | null;
};

/** The columns every notice below needs. Kept in one place so they agree. */
const AGENCY_BILLING_COLUMNS = "id, plan_status, payment_failed_at, plan, name, cancels_at, trial_ends_at";

/**
 * Tell the owners and admins that the renewal failed - once per episode.
 *
 * `payment_failed_at` is the key, not the event: Stripe raises a fresh
 * `invoice.payment_failed` on every card retry it makes for days, and retries
 * each of those events until it gets a 200. Keying on the moment the failure
 * *started* is what turns a week of retries into one email, and it is the same
 * timestamp the in-app dunning banner counts its grace window from, so the
 * date in the inbox is the date on the screen.
 *
 * Never allowed to fail the webhook. A non-200 makes Stripe redeliver, and a
 * redelivery whose only unfinished business is an email would re-run the state
 * writes for nothing.
 */
async function emailPaymentFailed(
  supabase: SupabaseClient,
  account: AccountBillingRow,
  failedAt: Date,
  invoice?: Stripe.Invoice,
): Promise<void> {
  try {
    // The window the customer actually has, counted from the recorded start -
    // which is the earlier of this failure and one already on the row.
    const episodeStart = isoKey(account.payment_failed_at) ?? failedAt.toISOString();
    const ends = graceEndsAt(episodeStart);
    if (!ends) return;
    // The window is already over - the account has lapsed, or the episode
    // predates this email existing. "You have until <a date last week>" is
    // not a warning; the Billing page already says lapsed.
    if (ends.getTime() <= Date.now()) return;
    // The trial's first charge has no grace window (lib/billing/dunning.ts):
    // the account never paid, and the email must not say the plan keeps
    // working for a week. `plan_status` is the state this failure leaves.
    const firstCharge = firstChargeFailed({
      plan_status: "past_due",
      trial_ends_at: account.trial_ends_at ?? null,
      payment_failed_at: episodeStart,
    });
    await notifyPaymentFailed(
      supabase,
      account.id,
      {
        accountName: account.name ?? null,
        planLabel: PLAN_LABELS[(account.plan ?? "starter") as PlanTier] ?? "your",
        graceEndsAt: ends.toISOString(),
        amount: formatInvoiceAmount(invoice),
        ...(firstCharge ? { firstCharge: true } : {}),
      },
      episodeStart,
    );
  } catch (err) {
    console.error(`[stripe] payment-failed email for ${account.id}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The same instant, as the string the ledger and the change checks key on.
 *
 * PostgREST renders a timestamptz as `2026-09-07T06:58:46+00:00`; `Date#toISOString`
 * gives `2026-09-07T06:58:46.000Z`. Comparing or keying on the raw strings
 * makes "unchanged" look changed and one dunning episode look like two.
 */
function isoKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

/** Where a tier sits on the ladder, so a switch can be called up or down. */
function rungOf(plan: string): number {
  return ["starter", "growth", "scale"].indexOf(plan);
}

/** Stripe's own amount and currency, or null. Never a number we worked out. */
function formatInvoiceAmount(invoice?: Stripe.Invoice): string | null {
  const cents = invoice?.amount_due;
  if (typeof cents !== "number" || !invoice?.currency) return null;
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: invoice.currency.toUpperCase() }).format(
      cents / 100,
    );
  } catch {
    return null;
  }
}

/**
 * The account an invoice belongs to, by the ids we stored at checkout.
 *
 * Stripe's invoice names its subscription under `parent.subscription_details`
 * (older API versions: a top-level `subscription`) and always its customer;
 * subscription metadata on the invoice is a snapshot of ours, so `account_id`
 * there is tried first.
 */
async function accountForInvoice(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice,
): Promise<AccountBillingRow | null> {
  const details = invoice.parent?.subscription_details ?? null;
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  const subscriptionId =
    typeof details?.subscription === "string"
      ? details.subscription
      : (details?.subscription?.id ?? (typeof legacy === "string" ? legacy : (legacy?.id ?? null)));
  const customerId = typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
  // `agency_id` is the key every subscription created before 085 (2026-09-09)
  // carries; Stripe metadata is a snapshot taken at purchase and is never
  // rewritten by a rename on our side. Read both for as long as one of
  // those subscriptions is alive.
  const metadataAccount = details?.metadata?.account_id ?? details?.metadata?.agency_id ?? null;

  const lookups: Array<[string, string]> = [];
  if (metadataAccount) lookups.push(["id", metadataAccount]);
  if (subscriptionId) lookups.push(["stripe_subscription_id", subscriptionId]);
  if (customerId) lookups.push(["stripe_customer_id", customerId]);

  for (const [col, val] of lookups) {
    const { data, error } = await supabase
      .from("accounts")
      .select(AGENCY_BILLING_COLUMNS)
      .eq(col, val)
      .maybeSingle();
    // A failed read is not "no account owns this invoice": answering that
    // returned 200 and Stripe never delivered the failure or the payment
    // again. Thrown, so the event answers 500 and is retried.
    if (error) throw new Error(`invoice: could not read the account by ${col} (${error.message})`);
    if (data) return data as AccountBillingRow;
  }
  return null;
}

/**
 * Record when the renewal started failing. Idempotent by construction: the
 * first failure sets the timestamp and every retry of the same run leaves it,
 * so the grace window (lib/billing/dunning.ts) is counted from the first
 * failed invoice, not the latest attempt. Cleared by `invoice.paid`.
 */
async function markPaymentFailed(
  supabase: SupabaseClient,
  account: AccountBillingRow,
  failedAt: Date,
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (!account.payment_failed_at) updates.payment_failed_at = failedAt.toISOString();
  // A paid plan goes past due, and so does a trial whose first charge
  // bounced: Stripe holds it `past_due` while it retries. Only a renewal gets
  // the grace window; a failure at the trial's end is lapsed at once
  // (lib/billing/dunning.ts, firstChargeFailed), because nothing was ever
  // paid. An `inactive` account that never subscribed does not become one.
  if (account.plan_status === "active" || account.plan_status === "trialing") updates.plan_status = "past_due";
  if (Object.keys(updates).length === 0) return;
  const { error } = await supabase.from("accounts").update(updates).eq("id", account.id);
  // Checked before the email that follows it: the grace window the email
  // quotes is counted from this timestamp, and a write that did not land
  // answered 200, so Stripe never retried it.
  if (error) throw new Error(`invoice.payment_failed: could not record the failed payment (${error.message})`);
}

/**
 * Stripe webhook. Signature-verified, then syncs subscription state into the
 * existing accounts.{plan, plan_status, stripe_*, current_period_end} columns.
 * The verified event is the only trusted input — never trust unsigned fields.
 */
export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    return NextResponse.json({ error: "Missing signature/secret" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, secret);
  } catch {
    // Not recorded: an unsigned POST to a public URL is somebody probing, and
    // a log full of that is a log nobody reads. A *misconfigured* secret shows
    // up as Stripe's own delivery failures in their dashboard.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = createServiceClient();

  try {
    await handleEvent(supabase, event);
  } catch (err) {
    // Nothing below catches anything. Until now a throw in any branch here
    // became a 500 with a stack trace in a function log: Stripe retried it for
    // up to three days, and if every retry failed the same way the account's
    // plan simply never changed. The money moved and the product did not
    // notice - the single most expensive silent failure in the app.
    //
    // Recorded, then rethrown unchanged: the 500 is what makes Stripe retry,
    // and swallowing it here would turn a loud failure into a quiet one.
    await recordEvent({
      level: "error",
      source: "stripe.webhook",
      message: `${event.type} could not be processed: ${describeError(err)}`,
      context: { eventId: event.id, eventType: event.type },
    }, supabase);
    throw err;
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(supabase: ReturnType<typeof createServiceClient>, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const accountId =
        session.metadata?.account_id ?? session.metadata?.agency_id ?? session.client_reference_id ?? undefined;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      if (accountId && customerId && subscriptionId) {
        // The subscription, not the session, says whether this opened a trial
        // and which tier it bills: read from Stripe, and a failed read is
        // thrown so the event is delivered again. The return page may have
        // recorded this checkout already (app/api/billing/checkout-status);
        // then nothing below writes or sends anything a second time.
        try {
          const subscription = await readCheckoutSubscription(subscriptionId);
          await activateCheckout(supabase, { accountId, customerId, subscription, hints: session.metadata });
        } catch (err) {
          throw new Error(`checkout.session.completed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      break;
    }

    // `created` fires for every new subscription, including ones that never
    // went through our checkout (a subscription started from the Stripe
    // dashboard, or a plan switch that replaces rather than updates). Handled
    // with `updated` because the work is identical: resolve the price to a
    // tier and write it.
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const plan = planForSubscription(sub);
      // Since API 2025-03-31.basil the period end lives on each item, not on
      // the subscription; the SDK here is pinned to a dahlia version, so the
      // top-level field is absent from every payload it describes. Read both:
      // the top level for an endpoint still on an older version, the first
      // item otherwise. Reading only the top level left the column null, and
      // the Billing page said "the end of the current billing period" where it
      // should have given a date.
      const periodEnd =
        (sub as unknown as { current_period_end?: number }).current_period_end ??
        (sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined)?.current_period_end;

      const status =
        event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status);

      const trialEnd = trialEndOf(sub);
      const updates: Record<string, unknown> = {
        ...(periodEnd ? { current_period_end: new Date(periodEnd * 1000).toISOString() } : {}),
        ...(plan ? { plan } : {}),
        // Stamped while trialing and never cleared: it is the record that
        // this account has had its one trial (lib/billing/trial.ts).
        ...(trialEnd ? { trial_ends_at: trialEnd } : {}),
        // Paid up again, or gone: either way nothing is failing any more.
        ...(status === "active" || status === "trialing" || status === "canceled"
          ? { payment_failed_at: null }
          : {}),
        // Any scheduled end, however it was set: cancel-at-period-end from the
        // Billing page or the portal, or a dated `cancel_at` from the Stripe
        // dashboard or the API (including the `min_period_end` /
        // `max_period_end` shorthands), which Stripe reports with
        // `cancel_at_period_end` false. Only the first used to be recorded, so
        // a trial ended by date kept drafting to its last day
        // (lib/billing/trial-hold.ts reads this column) and the Billing page
        // showed no end date. Cleared when the cancellation is undone.
        cancels_at:
          event.type === "customer.subscription.deleted"
            ? null
            : sub.cancel_at
              ? new Date(sub.cancel_at * 1000).toISOString()
              : null,
      };

      if (event.type === "customer.subscription.created") {
        // A new subscription is also where the customer and subscription ids
        // first exist for a purchase that did not come through our checkout.
        if (sub.customer) {
          updates.stripe_customer_id =
            typeof sub.customer === "string" ? sub.customer : sub.customer.id;
          updates.stripe_subscription_id = sub.id;
        }
        // `created` states what was bought, not whether it is paid for. Stripe
        // does not order it against `checkout.session.completed`, and a card
        // that needed 3-D Secure creates the subscription `incomplete`, so
        // writing that status here could arrive after the checkout handler and
        // knock a live account back to past_due. Only a status that is already
        // good is worth writing; anything else waits for `updated`.
        if (status === "active" || status === "trialing") updates.plan_status = status;
      } else {
        updates.plan_status = status;
      }

      // Pre-085 subscriptions carry `agency_id`; see `accountForInvoice`.
      const accountId = sub.metadata?.account_id ?? sub.metadata?.agency_id;

      // Read the row before writing it. Every notice below is about a
      // *change* - the tier moved, a cancellation was scheduled - and a change
      // cannot be seen once the new value is already in the column.
      const { data: beforeRow, error: beforeError } = await supabase
        .from("accounts")
        .select(AGENCY_BILLING_COLUMNS)
        .eq(accountId ? "id" : "stripe_subscription_id", accountId ?? sub.id)
        .maybeSingle();
      if (beforeError) throw new Error(`${event.type}: could not read the account (${beforeError.message})`);
      const before = (beforeRow as AccountBillingRow | null) ?? null;

      // Checked, and thrown before anything below, as checkout's own write
      // is. This write carries the status, the tier, the trial end and
      // `cancels_at`, which the drafting doors read to stop a cancelled
      // trial (lib/billing/trial-hold.ts); a write that failed answered 200,
      // Stripe never delivered the event again, and the account kept the
      // state it had before - drafting on after a cancel, or a paid tier
      // after a downgrade - with the emails below already sent as if it
      // had changed.
      const { error: writeError } = accountId
        ? await supabase.from("accounts").update(updates).eq("id", accountId)
        : // Fall back to matching by the stored subscription id.
          await supabase.from("accounts").update(updates).eq("stripe_subscription_id", sub.id);
      if (writeError) throw new Error(`${event.type}: could not record the subscription on the account (${writeError.message})`);

      // The plan has ended. A subscription cancelled at period end makes no
      // final invoice, so the last period's overage - pending items waiting
      // for a next invoice - was never billed. Billed now; a failure is thrown
      // so Stripe delivers the event again, and a redelivery finds nothing
      // pending and bills nothing twice.
      if (event.type === "customer.subscription.deleted" && sub.customer) {
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        try {
          await invoicePendingCharges(getStripe(), customerId, { paymentMethod: paymentMethodId(sub.default_payment_method) });
        } catch (err) {
          // A customer deleted at Stripe has nothing left to invoice, and
          // retrying would only fail the same way for three days.
          if ((err as { code?: string } | null)?.code !== "resource_missing") {
            throw new Error(`${event.type}: could not invoice the final period's overage (${err instanceof Error ? err.message : String(err)})`);
          }
          console.error(`[stripe] final overage: customer ${customerId} is gone at Stripe`);
        }
      }

      // Every remaining write and read comes before any email. A failure
      // below throws and Stripe delivers the event again; if the change
      // emails had already gone out, the retry would read the row this
      // delivery wrote, see nothing changed, and an email that failed the
      // first time would never be tried again.
      const previous = event.data.previous_attributes as Partial<Stripe.Subscription> | undefined;

      /**
       * The tier the subscription moved from, when this event moved it.
       *
       * The event's own `previous_attributes` first: the in-app switch writes
       * the new tier to the row the moment Stripe accepts it (actions/billing.ts),
       * and Stripe delivers this event after that, so the row read above
       * usually already held the new tier and the change email - which the
       * comment below promises for "our own in-place switch" - was skipped.
       * The row's tier stays the answer for a portal change, whose event the
       * row has not seen.
       */
      const previousTier = planForPriceId(previous?.items?.data?.[0]?.price?.id);
      const fromTier = (previousTier ?? before?.plan ?? null) as PlanTier | null;
      const tierMoved = Boolean(before && plan && fromTier && fromTier !== plan && status !== "canceled");
      const trialingNow = status === "trialing";
      const failedAt = new Date(event.created * 1000);
      const pastDue = event.type === "customer.subscription.updated" && status === "past_due";
      if (event.type === "customer.subscription.updated") {
        // Going past due without an `invoice.payment_failed` (the events are
        // not ordered) still starts the grace window, from now.
        if (pastDue && before && !before.payment_failed_at) {
          const { error: failedError } = await supabase
            .from("accounts")
            .update({ payment_failed_at: failedAt.toISOString() })
            .eq("id", before.id);
          if (failedError) throw new Error(`${event.type}: could not start the grace window (${failedError.message})`);
        }

        // The account pause ending on Stripe's side. `resumes_at` lifts
        // `pause_collection` on the date and Stripe reports it here with the
        // old value in `previous_attributes`; the workspaces the pause set
        // are resumed to match, so nothing is billed for a month in which
        // nothing was drafted. Only a change is acted on - an ordinary update
        // to an unpaused subscription also carries `pause_collection: null`
        // and must not touch a pause that was written a moment ago.
        const pauseLifted =
          sub.pause_collection == null && previous != null && "pause_collection" in previous;
        if (pauseLifted) {
          let target: string | null = accountId ?? null;
          if (!target) {
            const { data: row, error: targetError } = await supabase
              .from("accounts")
              .select("id")
              .eq("stripe_subscription_id", sub.id)
              .maybeSingle();
            if (targetError) throw new Error(`${event.type}: could not find the account whose pause ended (${targetError.message})`);
            target = (row?.id as string | undefined) ?? null;
          }
          if (target) await resumePausedWorkspaces(supabase, target);
        }

        // A downgrade slows every site to what the new tier includes. Nothing
        // did: a site at 25 a week on Agency kept that pace on Managed until
        // the month's 100 were used and scheduled writing stopped dead, while
        // the downgrade email said it "will slow to" the new pace. Only a
        // pace above the new ceiling moves, and only down.
        if (tierMoved && before && plan && fromTier && rungOf(plan) < rungOf(fromTier)) {
          const { data: sites, error: sitesError } = await supabase
            .from("workspaces")
            .select("id, auto_generate_weekly_limit")
            .eq("account_id", before.id);
          if (sitesError) throw new Error(`${event.type}: could not read the sites to slow to the new plan (${sitesError.message})`);
          for (const site of sites ?? []) {
            const next = paceOnDowngrade(site.auto_generate_weekly_limit as number | null, plan);
            if (next === null) continue;
            const { error: paceError } = await supabase
              .from("workspaces")
              .update({ auto_generate_weekly_limit: next })
              .eq("id", site.id);
            if (paceError) throw new Error(`${event.type}: could not slow a site to the new plan's pace (${paceError.message})`);
          }
        }
      }

      /**
       * The plan actually moved. Both doors reach here: our own in-place
       * switch (`subscriptions.update` on the item) and a change made in the
       * Stripe portal, which never touches our server otherwise.
       *
       * Keyed by the day as well as the tiers, so a customer who upgrades in
       * March and again in June after a downgrade still hears about June -
       * while the several `customer.subscription.updated` events one switch
       * produces collapse into one email.
       */
      if (tierMoved && before && plan && fromTier) {
        const from = fromTier;
        const day = new Date(event.created * 1000).toISOString().slice(0, 10);
        try {
          await notifyPlanChanged(
            supabase,
            before.id,
            {
              fromLabel: PLAN_LABELS[from] ?? from,
              toLabel: PLAN_LABELS[plan] ?? plan,
              articleLimit: PLAN_ARTICLE_LIMITS[plan] ?? null,
              upgrade: rungOf(plan) > rungOf(from),
              trialing: trialingNow,
            },
            `${from}->${plan}:${day}`,
          );
        } catch (err) {
          console.error(`[stripe] plan-changed email: ${err instanceof Error ? err.message : err}`);
        }
      }

      /**
       * A cancellation was scheduled.
       *
       * Sent from here rather than from `cancelPlan` because the Billing page
       * links straight into the Stripe portal's cancel flow, which never calls
       * our action - so an email wired to the action would miss whichever half
       * of the customers used the other button. Stripe's event is the fact,
       * and it arrives the same way from both.
       *
       * `customer.subscription.deleted` deliberately sends nothing. It is the
       * period end finally arriving on a cancellation this already announced,
       * weeks earlier, with the date on it; a second email then would tell
       * somebody who has already left that they have left. The rare immediate
       * cancellation is one we make from the Stripe dashboard, and it is on us
       * to say why.
       */
      const cancelsAt = updates.cancels_at as string | null;
      // Two ways to see that this event scheduled the end. The row moving
      // from null to a date covers the portal, which never calls our server.
      // The event's own `previous_attributes` covers the Billing page's
      // button: `cancelPlan` writes `cancels_at` itself the moment Stripe
      // answers, and Stripe delivers this event after that, so the row
      // already held the date and the in-app cancel sent no email at all.
      // `sendOnce` is keyed by the subscription, so the two cannot both send.
      const cancelScheduledNow =
        previous != null &&
        (("cancel_at" in previous && previous.cancel_at == null) ||
          ("cancel_at_period_end" in previous && previous.cancel_at_period_end === false));
      if (
        before &&
        event.type === "customer.subscription.updated" &&
        cancelsAt &&
        (isoKey(before.cancels_at) !== cancelsAt || cancelScheduledNow)
      ) {
        try {
          await notifySubscriptionCancelled(
            supabase,
            before.id,
            {
              accountName: before.name ?? null,
              planLabel: PLAN_LABELS[(before.plan ?? "starter") as PlanTier] ?? "your",
              endsAt: cancelsAt,
              // A trial ending before its first charge: drafting stops now,
              // not at the date, and the email must not say otherwise.
              trial: trialEnd !== null && Date.parse(cancelsAt) <= Date.parse(trialEnd),
            },
            sub.id,
          );
        } catch (err) {
          console.error(`[stripe] cancellation email: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Whether the window started here or on an earlier invoice event, the
      // people who can fix it are told once (keyed by the window's own
      // start, so the two routes cannot both send).
      if (pastDue && before) await emailPaymentFailed(supabase, before, failedAt);
      break;
    }

    // Dunning. Stripe retries a failed renewal on its own schedule and the
    // subscription sits `past_due` meanwhile; the app's job is to keep the
    // paid tier open for a grace window from the first failure and to say,
    // everywhere, that the card needs updating. Both handlers are safe to
    // replay: the first failure's timestamp is kept, and a paid invoice
    // clears it however many times it arrives.
    // Three days before a trial's first charge. Stripe sends this once per
    // trial; the email is deduped on the subscription anyway.
    case "customer.subscription.trial_will_end": {
      const sub = event.data.object as Stripe.Subscription;
      // Pre-085 subscriptions carry `agency_id`; see `accountForInvoice`.
      const accountId = sub.metadata?.account_id ?? sub.metadata?.agency_id;
      const { data: row, error: rowError } = await supabase
        .from("accounts")
        .select(AGENCY_BILLING_COLUMNS)
        .eq(accountId ? "id" : "stripe_subscription_id", accountId ?? sub.id)
        .maybeSingle();
      if (rowError) throw new Error(`${event.type}: could not read the account (${rowError.message})`);
      const account = (row as AccountBillingRow | null) ?? null;
      // A trial set to end - at its period end, or by a date on or before the
      // trial's end - is not about to be charged, and "your card will be
      // charged in three days" would be false.
      const endsBeforeCharge =
        sub.cancel_at_period_end || (sub.cancel_at != null && sub.trial_end != null && sub.cancel_at <= sub.trial_end);
      if (!account || sub.status !== "trialing" || endsBeforeCharge) break;
      const plan = planForSubscription(sub) ?? (account.plan as PlanTier | null) ?? "starter";
      try {
        await notifyTrialEnding(
          supabase,
          account.id,
          {
            planLabel: PLAN_LABELS[plan] ?? plan,
            planPrice: planChargeLabel(plan, intervalForSubscription(sub)),
            endsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : account.trial_ends_at ?? null,
          },
          sub.id,
        );
      } catch (err) {
        console.error(`[stripe] trial-ending email: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const account = await accountForInvoice(supabase, invoice);
      if (!account) break;
      const failedAt = new Date((invoice.created ?? event.created) * 1000);
      await markPaymentFailed(supabase, account, failedAt);
      await emailPaymentFailed(supabase, account, failedAt, invoice);
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const account = await accountForInvoice(supabase, invoice);
      if (!account) break;
      const updates: Record<string, unknown> = { payment_failed_at: null };
      // The retry that went through reinstates the plan. An `inactive` row
      // is a first purchase and `checkout.session.completed` owns that.
      if (account.plan_status === "past_due" || account.plan_status === "unpaid") updates.plan_status = "active";
      const { error } = await supabase.from("accounts").update(updates).eq("id", account.id);
      // A reinstatement that did not land left a paid account past due, and
      // lapsing, under a 200. Thrown so Stripe delivers the payment again.
      if (error) throw new Error(`invoice.paid: could not reinstate the plan (${error.message})`);
      break;
    }
  }
}
