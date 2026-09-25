// ---------------------------------------------------------------------------
// Nothing drafts before the trial but the first article
// ---------------------------------------------------------------------------
//
// The order the product promises a trial-gated account (decided 2026-09-25):
// onboarding writes ONE article, the gate shows it, and nothing else is
// written until the seven-day trial starts. The trial is what opens the rest
// of the week, which is then drafted straight away (lib/plan/resume-week.ts),
// and the month behind it at the site's pace.
//
// Until this file the hold was an argument one caller passed. Onboarding
// planned one entry for a gated account (`maxEntries: gated ? 1 : 5`) and
// every other door ignored the idea: cron/generate kept writing on the free
// allowance until seven drafts were used, gated only by "the first draft has
// been read"; the nightly top-up filled the gated calendar back up to a month
// the next morning; the agent API, the MCP tool and Write now would each have
// written a second draft for anyone who reached them. A real signup
// (2026-09-22) was on the path where the calendar said one article and the
// schedule planned five.
//
// So the hold is one predicate, and every drafting door asks it:
//
//   generateArticle            the choke point every draft passes through,
//                              including a re-check after its row exists so
//                              a burst of requests cannot slip two past it
//   cron/generate, cron/refresh  before any paid research, with the reason
//   /api/internal/draft        the onboarding worker's and the resume's door
//   agent API generate (+ MCP) before the row it would create
//   Write now                  before the frozen check
//   onboarding pipeline        before the keyword research for the first draft
//
// and the planner asks the same account question (`planHoldApplies`) before
// it writes a calendar entry, so the calendar and the writer cannot disagree
// about what the trial opens.
//
// Which accounts: exactly `trialGateApplies` (lib/billing/trial.ts) - no plan,
// never trialed, hosted billing on, not an operator, and the kill switch off.
// Self-host, operators and paying or trialing accounts are never held, and
// keep what they had.
//
// No-plan accounts that are NOT trial-gated keep the older rule, the first
// free draft waiting for a person to read it (lib/billing/first-draft-gate.ts).
// Those are the accounts that have had their trial (`trial_ends_at` stamped)
// or hold a lapsed subscription, and every no-plan account while
// TRIAL_GATE_DISABLED=1 is set. `draftBlocker` below is the one place that
// decides which of the two rules applies.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getQuota, type Quota } from "@/lib/billing/quota";
import { trialGateApplies } from "@/lib/billing/trial";
import { firstDraftAwaitsReview } from "@/lib/billing/first-draft-gate";
import { accountCountingClient } from "@/lib/billing/account-client";
import { billingEnabled, TRIAL_DAYS } from "@/lib/stripe";

/**
 * Drafts a trial-gated account gets before its trial starts: the article the
 * onboarding writes. The seven free drafts (FREE_DRAFTS) are not a pre-trial
 * budget for these accounts any more; the trial is.
 */
export const PRE_TRIAL_DRAFTS = 1;

/** The sentence every held door returns, word for word. */
export const TRIAL_HOLD_MESSAGE =
  `Waiting for your trial to start. Your first article is written; nothing more is drafted until the ${TRIAL_DAYS}-day trial begins, ` +
  `and then the rest of this week's plan is written straight away.`;

/**
 * Thrown by `generateArticle` when the hold refuses a draft. A class of its
 * own so the crons can report it as the skip it is rather than an error, and
 * so a caller can tell "held" from "broke" without matching on words.
 */
export class TrialHoldError extends Error {
  constructor(message: string = TRIAL_HOLD_MESSAGE) {
    super(message);
    this.name = "TrialHoldError";
  }
}

/** The slice of a quota the hold reads. */
export type HoldQuota = Pick<Quota, "reason" | "used"> & { trialEligible?: boolean };

/**
 * The hold, as a sentence, or null when this draft may be written. Pure.
 *
 * `adding` is how many drafts this call would add to `quota.used`:
 *
 *   1  a new article, checked before its row exists (the default), or a
 *      rewrite of an existing page, which is a draft of its own
 *   0  a new article re-checked after its own row was inserted (the row is
 *      already in the count), or generating into an article that already
 *      counts
 *
 * The rule is on the state after the call: a gated account may end up with
 * PRE_TRIAL_DRAFTS drafts and no more. A draft whose run died (`error`) is not
 * in `used` (lib/billing/quota.ts), so a first article that failed can be
 * tried again.
 */
export function trialHoldReason(quota: HoldQuota | null | undefined, opts: { adding?: number } = {}): string | null {
  if (!trialGateApplies(quota)) return null;
  const adding = opts.adding ?? 1;
  if ((quota?.used ?? 0) + adding <= PRE_TRIAL_DRAFTS) return null;
  return TRIAL_HOLD_MESSAGE;
}

/**
 * Why an unattended run must not write for this workspace, or null.
 *
 * One question with two rules, so a cron cannot ask one and forget the other:
 *
 *   trial-gated        the hold above
 *   other no-plan      the first free draft waits to be read (first-draft-gate)
 *   everyone else      nothing here; the plan limit is a volume, not a gate
 */
export async function draftBlocker(
  supabase: SupabaseClient,
  quota: HoldQuota,
  workspaceId: string,
): Promise<string | null> {
  const held = trialHoldReason(quota);
  if (held) return held;
  if (trialGateApplies(quota)) return null;
  if (quota.reason === "no-plan") return firstDraftAwaitsReview(supabase, workspaceId);
  return null;
}

/**
 * Whether the planner must hold this account's calendar at the first article.
 *
 * Asked about the account, never about whoever is calling: the planner runs
 * from the crons (no session), the Stripe webhook, the onboarding worker and
 * server actions, and the calendar must come out the same from all of them.
 * So the quota is read the way the crons read it - nobody's session, with
 * the operator bypass resolved from the account's members - through the
 * account-wide counting client.
 *
 * No Stripe key means no trial to wait for, so a self-hosted install never
 * reads anything here. A failed read throws rather than answering "not held":
 * a calendar planned from a read that did not happen is the silent zero the
 * quota refuses everywhere else.
 */
export async function planHoldApplies(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  if (!billingEnabled || process.env.TRIAL_GATE_DISABLED === "1") return false;
  const counting = accountCountingClient(supabase);
  const { data, error } = await counting.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`plan: could not read this site's account (${error.message})`);
  const accountId = (data?.account_id as string | undefined) ?? null;
  if (!accountId) throw new Error("plan: this site has no account to plan for");
  return trialGateApplies(await getQuota(counting, accountId, null));
}
