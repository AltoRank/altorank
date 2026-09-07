// ---------------------------------------------------------------------------
// One gate: may this account spend money right now?
// ---------------------------------------------------------------------------
//
// Until 2026-09-07 exactly two things were gated: writing a draft (against the
// article quota) and shipping one (`needsPlanToShip`). Everything else that
// costs us money was open to any signed-in free account, forever:
//
//   keyword research Generate, Chat and the Playbooks   model calls, 15 sites
//   adding a keyword by hand, and rescoring it          DataForSEO
//   the site audit's re-crawl                           DataForSEO + PageSpeed
//   brand-voice training                                model
//   SERP and backlink lookups                           DataForSEO
//   refresh candidates, briefs, improvements            model + DataForSEO
//   recommendation rescores                             DataForSEO
//   the GEO probes' on-demand path                      model, per probe
//   cron/generate, cron/site-pages, cron/serp-collect   nightly, unattended
//
// The rule this file enforces, in the owner's words: "The 7 a month is only on
// their first month. After that the subscription should be enforced for any
// new generation. People can still enter their accounts but any kind of
// action should be paid, all keyword searches etc should be gated."
//
// So: reading is free forever. Signing in, the dashboard, existing keywords,
// articles, audits and reports are never gated by this file. Anything that
// makes a provider call is.
//
// ---------------------------------------------------------------------------
// Why here and not in quota.ts or spend.ts
// ---------------------------------------------------------------------------
//
// `spend.ts` is taken, and by the opposite concern: it *records* what a call
// cost, after the fact, best-effort, and must never throw. This decides
// whether a call may happen at all and exists to refuse. Putting a gate that
// throws in the file whose contract is "bookkeeping never breaks the work it
// is measuring" would be a trap for the next reader.
//
// `quota.ts` answers a narrower question - how many articles are included, how
// many are used - and three things already read it for exactly that (the usage
// bar, the overage line, the forecast). The gate needs the quota plus the
// workspace pause plus the dunning state, and it answers with a reason and a
// sentence rather than a number. It is one level up, so it lives one file up
// and delegates: `getQuota` stays the single place that resolves plan,
// operator, self-host and dunning, and this file never re-derives any of them.
//
// There is deliberately no `assertCanSpend` that throws. Next.js replaces a
// thrown server-action message with an opaque digest in production
// (lib/billing/failure.ts), and a paywall whose reason arrives as a hex string
// is worse than no paywall: the person cannot even tell what happened. Every
// caller returns the decision as data, and the two route handlers answer 402
// with `message` in the body.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getQuota,
  quotaExceededMessage,
  freeAllowanceUsedMessage,
  freeAllowanceRuleChangeNote,
  FREE_DRAFTS,
  type Quota,
} from "@/lib/billing/quota";
import { accountPausedMessage } from "@/lib/billing/pause";
import { formatGraceDate } from "@/lib/billing/dunning";

/**
 * What kind of spending is being asked for.
 *
 * `draft` is the only one the free allowance is counted in: the allowance is
 * seven drafts, and research or a re-crawl does not consume one. Everything
 * else asks the same question - is this account entitled to spend at all - and
 * differs only in the noun the refusal uses.
 */
export type SpendAction =
  | "draft"
  | "keyword-research"
  | "keyword-scoring"
  | "site-audit"
  | "voice-training"
  | "serp-lookup"
  | "backlink-lookup"
  | "refresh"
  | "recommendations"
  | "geo-probe"
  | "scheduled-work";

/** What the refusal calls the thing, so one sentence serves all of them. */
const ACTION_NOUN: Record<SpendAction, string> = {
  draft: "Writing a draft",
  "keyword-research": "Keyword research",
  "keyword-scoring": "Looking up a keyword's volume and difficulty",
  "site-audit": "Re-crawling the site",
  "voice-training": "Learning your site's writing style",
  "serp-lookup": "Checking the search results",
  "backlink-lookup": "Checking backlinks",
  refresh: "Rewriting and improving existing pages",
  recommendations: "Rescoring the keyword queue",
  "geo-probe": "Asking the AI engines about this brand",
  "scheduled-work": "Scheduled work",
};

export type SpendAllowedReason =
  /** No STRIPE_SECRET_KEY: this install pays its own provider bills. */
  | "self-host"
  /** Our own account, so dogfooding does not eat a customer-shaped quota. */
  | "operator"
  /** An active subscription. */
  | "plan"
  /** Past due, inside the grace window: still the paid tier (PR #129). */
  | "grace"
  /** No plan yet, and some of the one-time free drafts are left. */
  | "free-allowance";

export type SpendBlockedReason =
  /** No plan, and the one-time seven have been written. */
  | "free-allowance-spent"
  /** Past due and the grace window has run out. */
  | "past-due"
  /** The subscription was cancelled, or never started. */
  | "no-plan"
  /** The account is paused from the Billing page. */
  | "paused";

export type SpendDecision =
  | { allowed: true; reason: SpendAllowedReason; quota: Quota; message: null }
  | { allowed: false; reason: SpendBlockedReason; quota: Quota; message: string };

export interface SpendGateOptions {
  /**
   * The caller's address. Same three-state contract as `getQuota`: omitted
   * means "look it up", `null` means "there is no session here" (the crons'
   * signal), an address means that person.
   */
  userEmail?: string | null;
  /**
   * The site the action is for. Only used for the account pause, which is
   * stored per workspace (`workspaces.paused_until`). Omit for an
   * account-level action.
   */
  workspaceId?: string;
  /** What is being asked for; picks the noun the refusal uses. */
  action?: SpendAction;
}

/**
 * May this agency spend on this workspace right now, and if not, why.
 *
 * Every branch carries a sentence the UI can print verbatim: what is locked,
 * why, and the way out. Never a code, never a digest, never a silent no-op.
 */
export async function canSpend(
  supabase: SupabaseClient,
  agencyId: string,
  options: SpendGateOptions = {},
): Promise<SpendDecision> {
  const action = options.action ?? "draft";
  const quota = await getQuota(supabase, agencyId, options.userEmail);

  // Self-host and operator first, and before the pause: an install with no
  // Stripe key has no billing to pause, and the operator bypass exists so our
  // own account is never the one a gate is tested on.
  if (quota.reason === "self-host") return { allowed: true, reason: "self-host", quota, message: null };
  if (quota.reason === "operator") return { allowed: true, reason: "operator", quota, message: null };

  // The pause is a promise in both directions - "Billing and article
  // generation pause" - so it outranks an active plan. A paused account is
  // paying nothing and must therefore cost nothing.
  if (options.workspaceId) {
    const paused = await pausedUntilFor(supabase, options.workspaceId);
    if (paused) {
      return { allowed: false, reason: "paused", quota, message: accountPausedMessage(paused) };
    }
  }

  if (quota.reason === "plan") {
    // `getQuota` has already folded the grace window into `plan` (dunning.ts),
    // so a card failing at renewal keeps working here. The distinction is kept
    // in the result because the UI says so out loud, and because "why did this
    // work" is a question worth being able to answer from one value.
    return {
      allowed: true,
      reason: quota.dunning?.state === "grace" ? "grace" : "plan",
      quota,
      message: null,
    };
  }

  // From here the account has no entitled plan.
  //
  // The free allowance is checked before the lapsed card, and the order is the
  // product's own promise: the dunning banner says "your plan is on hold and
  // the account is on the free tier until the card is updated", so an account
  // that still has free drafts really does keep them. In practice this changes
  // nothing for a real customer - somebody who was paying has written hundreds
  // of articles and their one-time seven went long ago - but the alternative
  // is a banner that says "free tier" over a product that refuses everything.
  const remaining = quota.remaining ?? 0;
  if (remaining > 0) {
    return { allowed: true, reason: "free-allowance", quota, message: null };
  }

  // Out of allowance, and the reason there is no plan matters: a failed card
  // is not the same news as never having subscribed, and offering Checkout to
  // somebody who already has a subscription is how an account ends up paying
  // twice (2026-09-06).
  if (quota.dunning?.state === "lapsed") {
    return {
      allowed: false,
      reason: "past-due",
      quota,
      message: pastDueMessage(action, quota),
    };
  }

  return {
    allowed: false,
    reason: quota.used > 0 ? "free-allowance-spent" : "no-plan",
    quota,
    message:
      action === "draft"
        ? quotaExceededMessage(quota)
        : `${ACTION_NOUN[action]} needs a plan. ${freeAllowanceUsedMessage(quota.limit ?? FREE_DRAFTS)} Reading everything already on the account stays free — your keywords, articles, audits and reports are all still there. Choose a plan on the Billing page to start spending again, or self-host AltoRank free.${freeAllowanceRuleChangeNote(quota)}`,
  };
}

/**
 * A card that failed and a grace window that has run out. Named as the card it
 * is, not as "choose a plan": the account has a plan, and offering Checkout
 * here is how someone ends up paying for two subscriptions (2026-09-06).
 */
function pastDueMessage(action: SpendAction, quota: Quota): string {
  const ended = quota.dunning?.graceEndsAt ? ` The grace period ended on ${formatGraceDate(quota.dunning.graceEndsAt)}.` : "";
  return `${ACTION_NOUN[action]} is paused: the last renewal payment did not go through.${ended} Update the card on the Billing page and everything starts again — nothing has been cancelled and nothing has been deleted.`;
}

/** The account pause date for a workspace, or null when it is not paused. */
async function pausedUntilFor(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from("workspaces")
    .select("status, paused_until")
    .eq("id", workspaceId)
    .maybeSingle();
  // Both, the same pairing `generate.ts` uses: `paused_until` alone is a site
  // paused by hand, which keeps its own settings and is not this gate's
  // business.
  if (data?.paused_until && data.status === "paused") return data.paused_until as string;
  return null;
}
