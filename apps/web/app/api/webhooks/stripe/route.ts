import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  getStripe,
  isSelfServePlan,
  planForPriceId,
  PLAN_ARTICLE_LIMITS,
  PLAN_LABELS,
  PLAN_PRICES,
  type PlanTier,
  type SelfServePlan,
} from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { recordEvent } from "@/lib/observability/record";
import { describe as describeError } from "@/lib/observability/event";
import { paceOnActivation } from "@/lib/content/pace";
import { resumePausedWorkspaces } from "@/lib/billing/resume";
import { graceEndsAt } from "@/lib/billing/dunning";
import {
  notifyPaymentFailed,
  notifyPlanChanged,
  notifySubscriptionCancelled,
  notifyTrialEnding,
  notifyTrialStarted,
} from "@/lib/email/lifecycle";
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
 * Which tier a completed checkout bought.
 *
 * `checkout.session.completed` carries no line items, so the price has to be
 * read off the subscription the session created. That read is the authoritative
 * answer - it is what Stripe bills - and `session.metadata.plan`, written by
 * `createCheckoutSession`, is the fallback for when the read fails or returns a
 * price id this deployment does not recognise.
 *
 * This exists because the handler used to write `stripe_customer_id`,
 * `stripe_subscription_id` and `plan_status` and *not* `plan`. `accounts.plan`
 * is `not null default 'starter'`, so a EUR 199 Agency buyer sat on Managed's
 * row - badged "Managed plan" on the Billing page and metered at
 * PLAN_ARTICLE_LIMITS.starter = 100 instead of 400, which also capped the pace
 * they were allowed to set - until some later `customer.subscription.updated`
 * happened to arrive and correct it (2026-09-06).
 */
export async function planForCheckoutSession(
  session: Stripe.Checkout.Session,
): Promise<SelfServePlan | undefined> {
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  if (subscriptionId) {
    try {
      const sub = await getStripe().subscriptions.retrieve(subscriptionId);
      const fromPrice = planForPriceId(sub.items?.data?.[0]?.price?.id);
      if (fromPrice) return fromPrice;
    } catch {
      // Fall through to the metadata hint. A Stripe read that fails must not
      // cost us the plan write; leaving the row on the default is the bug.
    }
  }

  const hint = session.metadata?.plan;
  return isSelfServePlan(hint) ? hint : undefined;
}

/**
 * Which tier a subscription is on: the price first, the metadata hint second.
 *
 * The same resolver as the checkout above, applied to the subscription object
 * an event carries. It matters most on `customer.subscription.updated` after
 * a plan switch: `switchPlan` changes the price on the existing item, and the
 * tier column has to follow the price, not the `plan` hint written when the
 * subscription was first bought.
 */
/**
 * The trial end on a checkout's subscription, as ISO, or null when the
 * subscription is not trialing. Read from Stripe rather than assumed from
 * the session, because whether checkout added trial days was decided by
 * `trialEligible` at session creation and the subscription is the record.
 */
export async function trialForCheckoutSession(session: Stripe.Checkout.Session): Promise<string | null> {
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!subscriptionId) return null;
  try {
    const sub = await getStripe().subscriptions.retrieve(subscriptionId);
    return trialEndOf(sub);
  } catch {
    return null;
  }
}

/** `trial_end` as ISO when the subscription is trialing, else null. */
export function trialEndOf(sub: Stripe.Subscription): string | null {
  if (sub.status !== "trialing" || !sub.trial_end) return null;
  return new Date(sub.trial_end * 1000).toISOString();
}

export function planForSubscription(sub: Stripe.Subscription): SelfServePlan | undefined {
  const fromPrice = planForPriceId(sub.items?.data?.[0]?.price?.id);
  if (fromPrice) return fromPrice;
  const hint = sub.metadata?.plan;
  return isSelfServePlan(hint) ? hint : undefined;
}

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
    await notifyPaymentFailed(
      supabase,
      account.id,
      {
        accountName: account.name ?? null,
        planLabel: PLAN_LABELS[(account.plan ?? "starter") as PlanTier] ?? "your",
        graceEndsAt: ends.toISOString(),
        amount: formatInvoiceAmount(invoice),
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
    const { data } = await supabase
      .from("accounts")
      .select(AGENCY_BILLING_COLUMNS)
      .eq(col, val)
      .maybeSingle();
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
  // A paid plan goes past due; an account that never paid does not become
  // one because its very first charge bounced.
  if (account.plan_status === "active" || account.plan_status === "trialing") updates.plan_status = "past_due";
  if (Object.keys(updates).length === 0) return;
  await supabase.from("accounts").update(updates).eq("id", account.id);
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
      if (accountId && session.customer && session.subscription) {
        const plan = await planForCheckoutSession(session);
        const trial = await trialForCheckoutSession(session);

        await supabase
          .from("accounts")
          .update({
            stripe_customer_id: String(session.customer),
            stripe_subscription_id: String(session.subscription),
            // A checkout that opened a trial is `trialing`, not paid: the
            // card is held and the first charge is on day eight. Writing
            // `active` here (the rule until 2026-09-09) would have shown a
            // trial as a paid plan and never counted it as the account's one
            // trial.
            plan_status: trial ? "trialing" : "active",
            ...(trial ? { trial_ends_at: trial } : {}),
            // The tier the money bought. Omitted only when neither the
            // subscription's price nor the session metadata resolved to a
            // plan we sell, in which case the later subscription event is the
            // last line of defence rather than the first.
            ...(plan ? { plan } : {}),
          })
          .eq("id", accountId);

        /**
         * Start writing at a paid pace.
         *
         * Signup sets FREE_TIER_PACE, which is right while the account is
         * free: the quota allows FREE_DRAFTS a calendar month, and the pace
         * matches so those drafts land inside the first week. It used to set
         * one a week against a one-draft month, and nothing raised it
         * afterwards, so a customer who paid for 100 a month kept getting
         * about four with no control anywhere to change it. `paceOnActivation`
         * only ever raises, and only from a value the product itself chose - a
         * site deliberately paused at 0, or set to anything that is not the
         * free-tier pace, is left alone.
         */
        const { data: sites } = await supabase
          .from("workspaces")
          .select("id, auto_generate_weekly_limit")
          .eq("account_id", accountId);
        for (const site of sites ?? []) {
          const next = paceOnActivation(site.auto_generate_weekly_limit as number | null, plan);
          if (next === null) continue;
          await supabase
            .from("workspaces")
            .update({ auto_generate_weekly_limit: next })
            .eq("id", site.id);
        }

        // The card was taken: say when it is charged and where to stop that.
        if (trial) {
          const tier = plan ?? "starter";
          try {
            await notifyTrialStarted(
              supabase,
              accountId,
              { planLabel: PLAN_LABELS[tier] ?? tier, planPrice: PLAN_PRICES[tier] ?? "", endsAt: trial },
              String(session.subscription),
            );
          } catch (err) {
            console.error(`[stripe] trial-started email: ${err instanceof Error ? err.message : err}`);
          }
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
      const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

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
        // Cancel-at-period-end set from the Billing page or from the portal
        // both land here; the page reads this column to say when the plan
        // ends. Cleared when the cancellation is undone.
        cancels_at:
          event.type === "customer.subscription.deleted"
            ? null
            : sub.cancel_at_period_end && sub.cancel_at
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
      const { data: beforeRow } = await supabase
        .from("accounts")
        .select(AGENCY_BILLING_COLUMNS)
        .eq(accountId ? "id" : "stripe_subscription_id", accountId ?? sub.id)
        .maybeSingle();
      const before = (beforeRow as AccountBillingRow | null) ?? null;

      if (accountId) {
        await supabase.from("accounts").update(updates).eq("id", accountId);
      } else {
        // Fall back to matching by the stored subscription id.
        await supabase.from("accounts").update(updates).eq("stripe_subscription_id", sub.id);
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
      if (before && plan && before.plan && before.plan !== plan && status !== "canceled") {
        const from = before.plan as PlanTier;
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
       * of the customers used the other button. `cancels_at` moving from null
       * to a date is the fact, and it arrives the same way from both.
       *
       * `customer.subscription.deleted` deliberately sends nothing. It is the
       * period end finally arriving on a cancellation this already announced,
       * weeks earlier, with the date on it; a second email then would tell
       * somebody who has already left that they have left. The rare immediate
       * cancellation is one we make from the Stripe dashboard, and it is on us
       * to say why.
       */
      const cancelsAt = updates.cancels_at as string | null;
      if (before && event.type === "customer.subscription.updated" && cancelsAt && isoKey(before.cancels_at) !== cancelsAt) {
        try {
          await notifySubscriptionCancelled(
            supabase,
            before.id,
            {
              accountName: before.name ?? null,
              planLabel: PLAN_LABELS[(before.plan ?? "starter") as PlanTier] ?? "your",
              endsAt: cancelsAt,
            },
            sub.id,
          );
        } catch (err) {
          console.error(`[stripe] cancellation email: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (event.type === "customer.subscription.updated") {
        // Going past due without an `invoice.payment_failed` (the events are
        // not ordered) still starts the grace window, from now.
        if (status === "past_due") {
          const failedAt = new Date(event.created * 1000);
          if (before && !before.payment_failed_at) {
            await supabase
              .from("accounts")
              .update({ payment_failed_at: failedAt.toISOString() })
              .eq("id", before.id);
          }
          // Whether the window started here or on an earlier invoice event,
          // the people who can fix it are told once (keyed by the window's
          // own start, so the two routes cannot both send).
          if (before) await emailPaymentFailed(supabase, before, failedAt);
        }

        // The account pause ending on Stripe's side. `resumes_at` lifts
        // `pause_collection` on the date and Stripe reports it here with the
        // old value in `previous_attributes`; the workspaces the pause set
        // are resumed to match, so nothing is billed for a month in which
        // nothing was drafted. Only a change is acted on - an ordinary update
        // to an unpaused subscription also carries `pause_collection: null`
        // and must not touch a pause that was written a moment ago.
        const previous = event.data.previous_attributes as Partial<Stripe.Subscription> | undefined;
        const pauseLifted =
          sub.pause_collection == null && previous != null && "pause_collection" in previous;
        if (pauseLifted) {
          let target: string | null = accountId ?? null;
          if (!target) {
            const { data: row } = await supabase
              .from("accounts")
              .select("id")
              .eq("stripe_subscription_id", sub.id)
              .maybeSingle();
            target = (row?.id as string | undefined) ?? null;
          }
          if (target) await resumePausedWorkspaces(supabase, target);
        }
      }
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
      const { data: row } = await supabase
        .from("agencies")
        .select(AGENCY_BILLING_COLUMNS)
        .eq(accountId ? "id" : "stripe_subscription_id", accountId ?? sub.id)
        .maybeSingle();
      const account = (row as AccountBillingRow | null) ?? null;
      if (!account || sub.status !== "trialing" || sub.cancel_at_period_end) break;
      const plan = planForSubscription(sub) ?? (account.plan as PlanTier | null) ?? "starter";
      try {
        await notifyTrialEnding(
          supabase,
          account.id,
          {
            planLabel: PLAN_LABELS[plan] ?? plan,
            planPrice: PLAN_PRICES[plan] ?? "",
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
      await supabase.from("accounts").update(updates).eq("id", account.id);
      break;
    }
  }
}
