// ---------------------------------------------------------------------------
// Who is writing a planned entry: claim before act
// ---------------------------------------------------------------------------
//
// A planned calendar entry can be drafted by three things that do not know
// about each other: the scheduled writer (cron/generate, four runs a day), the
// resume that drafts the rest of the week when a trial starts
// (lib/plan/resume-week.ts), and a Stripe event that arrives twice. Each used
// to decide "this entry is free" from a read, then write - and a read is not a
// lock. Two readers both see an entry with no article, and the entry gets two
// drafts, or a redelivered event pays for the week a second time.
//
// So an entry is claimed with one conditional UPDATE before anyone writes it
// (migration 093). Postgres lets exactly one of any number of concurrent
// callers match the WHERE; the rest get no row back and write nothing. The
// claim names its writer, so the draft route can check that the request it is
// holding is the one that won.
//
// A claim is not forever. The writer can die - a function cut off at its time
// limit leaves a claim with no article and no recorded failure - so a claim
// older than CLAIM_LEASE_MS counts as abandoned, and the scheduled writer may
// take it. A failure the writer did record hands the entry back at once, and
// the calendar says what went wrong. Nothing claimed is ever silently lost:
// either it gets an article, or it gets a failure the next scheduled run
// picks up, or its lease runs out and the next scheduled run picks it up.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How long a claim holds with nothing to show for it. A draft is 100-280s
 * inside a 300s function (lib/content/fan-out.ts), so fifteen minutes is past
 * any writer that is still alive.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/** Kept short: the column is shown on the calendar, not a log. */
const MAX_FAILURE_CHARS = 500;

function leaseCutoff(now: Date): string {
  return new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
}

/**
 * The PostgREST filter for "nobody is writing this right now": never claimed,
 * the last writer recorded a failure, or its lease ran out.
 */
export function claimableFilter(now: Date = new Date()): string {
  return `draft_claimed_at.is.null,draft_failed_at.not.is.null,draft_claimed_at.lt.${leaseCutoff(now)}`;
}

export interface ClaimOptions {
  /**
   * Only an entry nobody has ever claimed. The trial resume asks for this:
   * a second delivery of the same Stripe event must draft nothing new, and
   * an entry the first delivery failed on belongs to the scheduled writer now,
   * not to a retry of the event.
   */
  fresh?: boolean;
  now?: Date;
}

/**
 * Claim one planned entry for `by`. True when this caller won it.
 *
 * Only an entry still waiting to be written can be claimed: queued, with no
 * article. Winning clears any failure an earlier writer recorded, so the
 * calendar stops showing it while the new attempt runs.
 */
export async function claimEntry(
  supabase: SupabaseClient,
  entryId: string,
  by: string,
  opts: ClaimOptions = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  let q = supabase
    .from("calendar_entries")
    .update({
      draft_claimed_at: now.toISOString(),
      draft_claimed_by: by,
      draft_failed_at: null,
      draft_failure: null,
    })
    .eq("id", entryId)
    .eq("status", "queue")
    .is("article_id", null);
  q = opts.fresh ? q.is("draft_claimed_at", null) : q.or(claimableFilter(now));
  const { data, error } = await q.select("id");
  if (error) throw new Error(`could not claim the planned entry: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Record why a claimed entry was not written, so the calendar can say it and
 * the next scheduled run takes the entry back.
 *
 * Only the claim's own writer may record against it: a late failure from a
 * request that lost its lease must not overwrite the entry's current writer.
 * Never throws; the failure being recorded is already the bad news.
 *
 * `ifUnrecorded` is for a dispatcher reading its request's status: the draft
 * route records its own failure, in the writer's words, and then answers 500,
 * and "the draft could not be started (500)" must not replace "the model
 * timed out". It only records when nothing has been recorded yet - which is
 * the case when the platform killed the route before it could say anything.
 */
export async function recordEntryFailure(
  supabase: SupabaseClient,
  entryId: string,
  by: string,
  failure: string,
  now: Date = new Date(),
  opts: { ifUnrecorded?: boolean } = {},
): Promise<void> {
  let q = supabase
    .from("calendar_entries")
    .update({ draft_failed_at: now.toISOString(), draft_failure: failure.slice(0, MAX_FAILURE_CHARS) })
    .eq("id", entryId)
    .eq("draft_claimed_by", by)
    .is("article_id", null);
  if (opts.ifUnrecorded) q = q.is("draft_failed_at", null);
  const { error } = await q;
  if (error) console.error(`[draft-claim] could not record the failure on ${entryId}: ${error.message}`);
}

/**
 * Give a claim back without a failure: the writer found the keyword already
 * being written by somebody else, which is not the entry's fault. Only the
 * claim's own writer can release it. Never throws.
 */
export async function releaseClaim(supabase: SupabaseClient, entryId: string, by: string): Promise<void> {
  const { error } = await supabase
    .from("calendar_entries")
    .update({ draft_claimed_at: null, draft_claimed_by: null })
    .eq("id", entryId)
    .eq("draft_claimed_by", by)
    .is("article_id", null);
  if (error) console.error(`[draft-claim] could not release ${entryId}: ${error.message}`);
}

/**
 * Record a refusal on entries nobody has claimed: the spend gate said no
 * before any writer was chosen. The entries stay unclaimed, so the scheduled
 * writer - which asks the same gate - takes them when the gate opens.
 */
export async function recordUnclaimedFailure(
  supabase: SupabaseClient,
  entryIds: readonly string[],
  failure: string,
  now: Date = new Date(),
): Promise<void> {
  if (!entryIds.length) return;
  const { error } = await supabase
    .from("calendar_entries")
    .update({ draft_failed_at: now.toISOString(), draft_failure: failure.slice(0, MAX_FAILURE_CHARS) })
    .in("id", [...entryIds])
    .is("draft_claimed_at", null)
    .is("article_id", null);
  if (error) console.error(`[draft-claim] could not record the refusal: ${error.message}`);
}

/**
 * Claims on this workspace whose writer is, as far as anyone can tell, still
 * writing: inside the lease, no article yet, no failure recorded.
 */
export async function claimsInFlight(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const { count, error } = await supabase
    .from("calendar_entries")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null)
    .is("draft_failed_at", null)
    .gte("draft_claimed_at", leaseCutoff(now));
  // An unknown is never a zero: a count that failed would let a second batch
  // start beside the first.
  if (error) throw new Error(`could not count the drafts being written: ${error.message}`);
  return count ?? 0;
}
