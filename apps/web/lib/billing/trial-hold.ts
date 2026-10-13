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
//
// ---------------------------------------------------------------------------
// And nothing drafts after a trial is cancelled
// ---------------------------------------------------------------------------
//
// The other end of the trial. Cancelling during the trial sets
// `cancel_at_period_end`, and Stripe keeps the subscription `trialing` until
// its last day, so `getQuota` answered `reason: "plan"` and every door above
// wrote on: the week's burst, the scheduled writer at the paid pace, Write
// now, the agent API. A person who cancelled on day two was drafted the rest
// of the week for a charge that will never happen (assessment 2026-09-29).
//
// The rule, from the billing code as it stands:
//
//   trial cancelled before its first charge   new drafting stops at once;
//     (trialing, and `cancels_at` at or        the drafts already written stay
//     before `trial_ends_at`)                  readable until the trial ends
//   paid subscription set to cancel           keeps its paid volume to the
//     at period end                            end of the period it paid for
//
// `trialCancelledReason` is that rule, and it is asked wherever the hold is:
// `generateArticle` (the choke point), `draftBlocker` (the crons), the spend
// gate's drafting actions (the week's burst, the scheduled writer, the
// editor's rewrites) and, through `draftHoldReason`, every door that asked
// `trialHoldReason` before its own research. "Keep my plan" clears
// `cancels_at` (app/actions/retention.ts, and the webhook for the portal),
// and drafting resumes with it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getQuota, type Quota } from "@/lib/billing/quota";
import { trialGateApplies } from "@/lib/billing/trial";
import { firstDraftAwaitsReview } from "@/lib/billing/first-draft-gate";
import { accountCountingClient } from "@/lib/billing/account-client";
import { billingEnabled } from "@/lib/stripe";
import { TRIAL_HOLD_MESSAGE, trialCancelledMessage } from "@/lib/billing/trial-refusal";

/**
 * Drafts a trial-gated account gets before its trial starts: the article the
 * onboarding writes. The seven free drafts (FREE_DRAFTS) are not a pre-trial
 * budget for these accounts any more; the trial is.
 */
export const PRE_TRIAL_DRAFTS = 1;

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
export type HoldQuota = Pick<Quota, "reason" | "used"> & { trialEligible?: boolean; trial?: Quota["trial"] };

/**
 * Whether this account's trial was cancelled before its first charge. Pure.
 *
 * Trialing (`quota.trial`, which `getQuota` sets only for a `trialing`
 * account on a plan) with a cancellation dated at or before the trial's end:
 * Stripe cancels at the period end, which during a trial IS the trial end, so
 * the card is never charged. A cancellation dated after the trial end is one
 * that will be charged first, and keeps drafting like any paid plan set to
 * end. A paid (`active`) subscription set to cancel has no `trial` and is
 * never this.
 *
 * Known edge, accepted: nothing records whether an invoice was ever paid, so
 * a customer who paid before and is later given a trial period from the
 * Stripe dashboard (a comp or an extension), then schedules a cancel inside
 * it, is read as this too and stops drafting at once. Every trial this
 * product starts is the first one (lib/billing/trial.ts, trialEligible), so
 * only a hand-made trial can reach it.
 */
export function trialCancelledBeforeCharge(quota: Pick<HoldQuota, "reason" | "trial"> | null | undefined): boolean {
  if (quota?.reason !== "plan") return false;
  const trial = quota.trial;
  if (!trial?.cancelsAt) return false;
  const cancels = Date.parse(trial.cancelsAt);
  const ends = Date.parse(trial.endsAt);
  if (Number.isNaN(cancels) || Number.isNaN(ends)) return false;
  return cancels <= ends;
}

/**
 * The cancelled-trial rule, as a sentence, or null when drafting may go on.
 * Refuses whatever the draft would add: a regeneration or a rewrite is as
 * paid as a new article, and none of them is what a cancelled trial keeps.
 */
export function trialCancelledReason(quota: Pick<HoldQuota, "reason" | "trial"> | null | undefined): string | null {
  if (!trialCancelledBeforeCharge(quota)) return null;
  return trialCancelledMessage(quota!.trial!.endsAt);
}

/**
 * The question every drafting door asks before its own research: the hold
 * before the trial, then the cancelled trial. Null when the draft may be
 * written as far as the trial is concerned; the quota's own volume is the
 * door's next question.
 */
export function draftHoldReason(quota: HoldQuota | null | undefined, opts: { adding?: number } = {}): string | null {
  return trialHoldReason(quota, opts) ?? trialCancelledReason(quota);
}

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
 * Whether `articleId` is one of the account's first PRE_TRIAL_DRAFTS drafts:
 * the tie-break for first drafts that raced past the hold.
 *
 * `generateArticle` re-counts after inserting its row, and two first drafts
 * racing on different keywords (two sites onboarding at once) each count the
 * other's row and see two. Refusing on the count alone refused both - the
 * account ended up with no article and a message saying its first one was
 * written. So the count says a race happened, and this says who won it: the
 * earliest row by (created_at, id) among the account's drafts that count,
 * which every racer computes the same way, so exactly one keeps its row.
 *
 * Read account-wide, as the quota is (`accountCountingClient`). A failed read
 * throws: the caller is deciding whether to keep a paid draft, and an unknown
 * is not a yes.
 */
export async function isFirstPreTrialDraft(supabase: SupabaseClient, accountId: string, articleId: string): Promise<boolean> {
  const counting = accountCountingClient(supabase);
  const { data: sites, error } = await counting.from("workspaces").select("id").eq("account_id", accountId);
  if (error) throw new Error(`trial hold: could not read this account's sites (${error.message})`);
  const ids = (sites ?? []).map((w) => w.id as string);
  if (!ids.length) return false;
  const { data: first, error: firstError } = await counting
    .from("articles")
    .select("id")
    .in("workspace_id", ids)
    // The drafts `getQuota` counts: a run killed before a word was written
    // (`error`) is not one.
    .neq("status", "error")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PRE_TRIAL_DRAFTS);
  if (firstError) throw new Error(`trial hold: could not read this account's first drafts (${firstError.message})`);
  return (first ?? []).some((a) => a.id === articleId);
}

/**
 * Take the account's pre-trial draft, before anything is bought for it.
 * True when this caller holds it; false when it is already taken.
 *
 * The attempt is what is counted, not the success. The hold used to read
 * only drafts that survived: articles not in `error`, plus
 * `free_drafts_used`, which the writer recorded once a draft was SAVED and
 * only on the path that inserted its own row. So a draft that failed after
 * its research was bought counted for nothing, and a client could make one
 * fail on purpose - flip the row to `error`, point the site at a model that
 * does not exist - and buy the next, and the one after (round-4 review).
 * Every draft the agent API started went through the in-place path, which
 * recorded nothing at all.
 *
 * So the counter moves first, here, on every path that would produce a
 * pre-trial draft, and a draft that fails afterwards keeps its count. It is
 * a compare-and-set on the stored value: of any number of callers racing for
 * the one draft (parallel requests on several `error` rows, two sites
 * onboarding at once), exactly one moves it and the rest are refused before
 * they spend. The column is server-written only (migration 099), and written
 * here with the service role whatever client the caller holds.
 *
 * The price is that a first article our own platform fails to write once
 * the research is bought is not written again before the trial: the trial
 * drafts it with the rest of the week, and the gate screen says so
 * (lib/onboarding/setup-retry.ts). Refunding a failed attempt would reopen
 * the loop, because a client can cause the failure. A run that stops BEFORE
 * anything is bought gives it back (releasePreTrialDraft): there is nothing
 * to loop on when nothing was spent.
 */
export async function claimPreTrialDraft(supabase: SupabaseClient, accountId: string): Promise<boolean> {
  const counting = accountCountingClient(supabase);
  // A handful of rounds: each lost round means someone else moved the value,
  // which almost always means they took the draft.
  for (let round = 0; round < 3; round++) {
    const { data, error } = await counting.from("accounts").select("free_drafts_used").eq("id", accountId).maybeSingle();
    if (error) throw new Error(`trial hold: could not read this account's pre-trial draft (${error.message})`);
    if (!data) throw new Error("trial hold: this account does not exist");
    const current = (data.free_drafts_used as number | null) ?? 0;
    if (current >= PRE_TRIAL_DRAFTS) return false;
    const { data: moved, error: claimError } = await counting
      .from("accounts")
      .update({ free_drafts_used: current + 1 })
      .eq("id", accountId)
      .eq("free_drafts_used", current)
      .select("id");
    if (claimError) throw new Error(`trial hold: could not claim the pre-trial draft (${claimError.message})`);
    if (moved && moved.length > 0) return true;
  }
  return false;
}

/**
 * Give the pre-trial draft back, for a run that claimed it and stopped
 * before anything was bought: the article row could not be found or
 * written, or the job row could not be. `generateArticle` claims after every
 * refusal that costs nothing and before the row, so the stretch between the
 * claim and the job row reads and writes our own tables and buys nothing -
 * a failure there left the account with no article and no way to one before
 * the trial (round-5 review), for no money spent. From the job row on the
 * research is bought, and the claim is kept (see claimPreTrialDraft).
 *
 * A compare-and-set from the value the claim wrote, so it can only undo that
 * claim: if anything else moved the counter since, it is left alone. Best
 * effort - the run is already failing with its own error, which is the one
 * worth reporting - and logged when it does not land.
 */
export async function releasePreTrialDraft(supabase: SupabaseClient, accountId: string): Promise<void> {
  try {
    const { error } = await accountCountingClient(supabase)
      .from("accounts")
      .update({ free_drafts_used: PRE_TRIAL_DRAFTS - 1 })
      .eq("id", accountId)
      .eq("free_drafts_used", PRE_TRIAL_DRAFTS);
    if (error) console.warn(`[trial-hold] could not give the pre-trial draft back: ${error.message}`);
  } catch (err) {
    console.warn("[trial-hold] could not give the pre-trial draft back:", err instanceof Error ? err.message : err);
  }
}

/**
 * Setup runs an account may start before its trial: the first, and one more
 * after a run that failed. A run buys the site read and the keyword research
 * (about $0.22), and a setup that finished without writing an article - no
 * candidate worth writing, a refused site, an unreadable crawl - left the
 * draft counter at zero, so the spend gate let the same account run it again
 * each time the last one ended (round-4 review).
 */
export const PRE_TRIAL_SETUP_RUNS = 2;

/**
 * How many setup runs this account has started, ever. `onboarding_runs` is
 * written by the server only (076: a client token may read it, nothing else),
 * and since migration 100 a run outlives the site it was for, so deleting a
 * site and adding it again does not give the runs back. Read account-wide; a
 * failed read throws, because the caller is deciding whether to buy a run.
 */
export async function setupRunsStarted(supabase: SupabaseClient, accountId: string): Promise<number> {
  const { count, error } = await accountCountingClient(supabase)
    .from("onboarding_runs")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (error) throw new Error(`setup: could not count this account's setup runs (${error.message})`);
  return count ?? 0;
}

/**
 * Why an unattended run must not write for this workspace, or null.
 *
 * One question with three rules, so a cron cannot ask one and forget another:
 *
 *   trial-gated        the hold above
 *   trial cancelled    nothing more before the trial ends (trialCancelledReason)
 *   other no-plan      the first free draft waits to be read (first-draft-gate)
 *   everyone else      nothing here; the plan limit is a volume, not a gate
 */
export async function draftBlocker(
  supabase: SupabaseClient,
  quota: HoldQuota,
  workspaceId: string,
): Promise<string | null> {
  const held = draftHoldReason(quota);
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
  return (await planHold(supabase, workspaceId)) !== "open";
}

/**
 * The hold, with whether the one pre-trial article has already been
 * attempted:
 *
 *   open    not held (self-host, operator, a plan, a trial, the kill switch)
 *   held    held, and the first article is still to come: one entry
 *   spent   held, and the first article has been attempted: nothing at all
 *
 * "Spent" is read from the server-written count (`quota.used`, floored by
 * `accounts.free_drafts_used`, which the claim moves before anything is
 * bought), never from the calendar. The planner's cap used to be checked
 * against the site's calendar entries alone, and a client token can delete
 * an entry or mark it done: the next nightly top-up then found room for
 * "the first article" again and bought qualification to fill it, every
 * night (round-4 review).
 */
export type PlanHold = "open" | "held" | "spent";

export async function planHold(supabase: SupabaseClient, workspaceId: string): Promise<PlanHold> {
  if (!billingEnabled || process.env.TRIAL_GATE_DISABLED === "1") return "open";
  const counting = accountCountingClient(supabase);
  const { data, error } = await counting.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`plan: could not read this site's account (${error.message})`);
  const accountId = (data?.account_id as string | undefined) ?? null;
  if (!accountId) throw new Error("plan: this site has no account to plan for");
  const quota = await getQuota(counting, accountId, null);
  if (!trialGateApplies(quota)) return "open";
  return quota.used >= PRE_TRIAL_DRAFTS ? "spent" : "held";
}
