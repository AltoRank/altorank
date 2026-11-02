// ---------------------------------------------------------------------------
// The card-less trial: seven days of Managed without a card, then Free
// ---------------------------------------------------------------------------
//
// The card trial (lib/billing/trial.ts) asked for a card on the gate, under
// the first article, and the card was where owners stopped: they read the
// price and left, or pressed and left at the card form. The trial now starts
// from the same button with no card. It is a reverse trial: Managed for TRIAL_DAYS, capped
// at CARDLESS_TRIAL_ARTICLES articles. The card is asked for when the cap or
// the end comes, to keep the pace. Without a card the account lands on the
// Free floor (`FREE_FLOOR_MONTHLY`, lib/billing/quota.ts) and keeps everything
// already written.
//
// The row is the one the card trial uses, minus Stripe: `plan_status =
// 'trialing'`, `plan = 'starter'`, `trial_ends_at` stamped, and no
// `stripe_subscription_id`. planEntitled already bounds `trialing` by its end
// date (lib/billing/dunning.ts), so the trial closes itself on day eight
// with no webhook to wait for. Adding a card opens an ordinary Stripe
// checkout whose trial ends when this one does (`checkoutTrialEnd`). The
// webhook then writes the subscription over this row as it does for any
// trial.
//
// What stands in for the card as a filter:
//
//   one trial per site   a domain whose site was already trialed, by any
//                        account, gets the card trial (`domainAlreadyTrialed`)
//   one per account      the conditional update below, the same rule as the
//                        card trial's `trial_ends_at`
//   a ceiling            CARDLESS_TRIAL_ARTICLES, counted for the life of
//                        the trial (getQuota)
//   disposable inboxes   refused at signup (lib/auth/disposable-email.ts)
//
// `CARDLESS_TRIAL_DISABLED=1` brings the card trial back with no deploy.

import type { SupabaseClient } from "@supabase/supabase-js";
import { billingEnabled, TRIAL_DAYS } from "@/lib/stripe";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Articles a card-less trial writes in all, the first one included. */
export const CARDLESS_TRIAL_ARTICLES = 4;

/** New articles a month on the Free floor, once a trial has ended without a card. */
export const FREE_FLOOR_MONTHLY = 1;

/**
 * Stripe Checkout refuses a `trial_end` closer than 48 hours. A card added
 * on the trial's last day keeps the trial to this floor, an hour clear of it.
 */
const STRIPE_MIN_TRIAL_MS = 49 * 60 * 60 * 1000;

export function cardlessTrialOn(): boolean {
  return billingEnabled && process.env.CARDLESS_TRIAL_DISABLED !== "1";
}

export type CardlessRow = {
  plan_status?: string | null;
  stripe_subscription_id?: string | null;
  trial_ends_at?: string | null;
  billing_provider?: string | null;
};

/** A trial with no card behind it: trialing, Stripe-billed, and no subscription. */
export function isCardlessTrial(account: CardlessRow | null | undefined): boolean {
  if (!account || account.plan_status !== "trialing") return false;
  if (account.billing_provider === "shopify") return false;
  return !account.stripe_subscription_id;
}

/**
 * The `trial_end` (Unix seconds) a checkout should carry so the card picks up
 * where the card-less trial is: its own end, or Stripe's 48-hour floor when
 * that is sooner. Null for anything that is not a running card-less trial.
 */
export function checkoutTrialEnd(account: CardlessRow | null | undefined, now: Date = new Date()): number | null {
  if (!isCardlessTrial(account)) return null;
  const ends = Date.parse(account?.trial_ends_at ?? "");
  if (!Number.isFinite(ends) || ends <= now.getTime()) return null;
  return Math.ceil(Math.max(ends, now.getTime() + STRIPE_MIN_TRIAL_MS) / 1000);
}

/** "www.Example.com/" to "example.com": how one site is told from another. */
export function siteKey(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/**
 * Whether another account has already had a trial on this site. A new
 * address per trial is free, so the site is what one trial is counted
 * against. A read that fails says yes: the card trial is the safe answer.
 */
export async function domainAlreadyTrialed(db: SupabaseClient, accountId: string, domain: string): Promise<boolean> {
  const key = siteKey(domain);
  if (!key) return false;
  const { data, error } = await db
    .from("workspaces")
    .select("account_id, accounts!inner(trial_ends_at)")
    .in("domain", [key, `www.${key}`])
    .neq("account_id", accountId)
    .not("accounts.trial_ends_at", "is", null)
    .limit(1);
  if (error) {
    console.warn(`[cardless-trial] could not check ${key} for an earlier trial: ${error.message}`);
    return true;
  }
  return (data ?? []).length > 0;
}

export type CardlessStart = { ok: true; endsAt: string } | { ok: false; reason: "off" | "site_trialed" | "not_eligible" | "failed" };

/**
 * Start the trial: one conditional write, so two presses (or two tabs)
 * start one trial, and an account that already trialed or holds a
 * subscription is left alone. Service client: `plan` and `plan_status` are
 * columns migration 072 refuses to a signed-in user.
 */
export async function startCardlessTrial(
  db: SupabaseClient,
  input: { accountId: string; domains: string[] },
  now: Date = new Date(),
): Promise<CardlessStart> {
  if (!cardlessTrialOn()) return { ok: false, reason: "off" };
  for (const domain of input.domains) {
    if (await domainAlreadyTrialed(db, input.accountId, domain)) return { ok: false, reason: "site_trialed" };
  }
  const endsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString();
  const { data, error } = await db
    .from("accounts")
    .update({ plan: "starter", plan_status: "trialing", trial_ends_at: endsAt })
    .eq("id", input.accountId)
    .is("trial_ends_at", null)
    .is("stripe_subscription_id", null)
    .neq("billing_provider", "shopify")
    .not("plan_status", "in", "(active,trialing,past_due)")
    .select("id");
  if (error) {
    console.error(`[cardless-trial] could not start for ${input.accountId}: ${error.message}`);
    return { ok: false, reason: "failed" };
  }
  return (data ?? []).length ? { ok: true, endsAt } : { ok: false, reason: "not_eligible" };
}
