// ---------------------------------------------------------------------------
// The qualified queue: kept short, refilled on demand, never grown for its own sake
// ---------------------------------------------------------------------------
//
// A keyword row is in one of four states, and only one of them is a thing
// the writer may take:
//
//   unjudged   status `new`, no current verdict. Eligible for qualification.
//   ready      status `new`, a current `qualified` verdict. The queue.
//   parked     status `stored` with `plan_excluded_at` set and the verdict
//              that parked it. Never taken by the cron or the planner, shown
//              on the keywords page with the reason, kept for the day the
//              profile changes or a person overrules. A row parked for want
//              of a verdict (cause `unjudged`) is the one exception: it is
//              judged again when the queue needs topics.
//   in flight  planned, drafting, scheduled, shipped.
//
// Until 2026-09-15 the pool was a list to grow: altorank.co held 274 open
// terms from five generations of research code, one of them qualified, and
// the nightly judge spent fifteen slots a night sifting sediment. The queue
// only needs as many ready topics as the pace will use in the next week or
// so, and research only needs to run when it drops below that.

import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_PACE } from "@/lib/content/pace";
import {
  contextKey,
  qualifyOpportunities,
  readOpportunity,
  OPPORTUNITY_VERSION,
  QUALIFICATION_LIMIT,
  type FirstLook,
  type Opportunity,
  type OpportunityCandidate,
  type OpportunityContext,
} from "./opportunity";
import type { IntentLeader } from "./intent-leaders";
import { SpendRefusedError } from "@/lib/billing/spend-gate";

/** Never fewer ready topics than this, whatever the pace. */
export const QUEUE_MIN = 3;
/** Batches of verdicts one refill may buy; bounds a cron pass. */
export const REFILL_MAX_BATCHES = 2;

/**
 * How many ready topics the queue should hold: about ten days of the pace.
 * Seven a week wants ten; one a week wants the floor.
 */
export function queueTarget(weeklyLimit: number | null | undefined): number {
  const weekly = Math.max(0, Math.min(MAX_PACE, Math.floor(weeklyLimit ?? 7)));
  return Math.max(QUEUE_MIN, Math.ceil((weekly * 10) / 7));
}

/** The row fields the queue reads. */
export interface QueueRow {
  id: string;
  term: string;
  status: string;
  source_url?: string | null;
  opportunity?: unknown;
  plan_excluded_at?: string | null;
  /** Kept by the buyer test with no measured demand: its verdict is labelled so. */
  unmeasured?: boolean;
  /** The saved buyer-test verdict, reused by qualification when it answers today's question. */
  buyer_fit?: unknown;
}

const rawStatus = (row: QueueRow): string | undefined => {
  const o = row.opportunity as { status?: unknown } | null | undefined;
  return o && typeof o === "object" && typeof o.status === "string" ? o.status : undefined;
};
const rawCause = (row: QueueRow): string | undefined => {
  const o = row.opportunity as { cause?: unknown } | null | undefined;
  return o && typeof o === "object" && typeof o.cause === "string" ? o.cause : undefined;
};

export function isParked(row: QueueRow): boolean {
  return Boolean(row.plan_excluded_at);
}

/**
 * Refusals about the results page rather than the searcher. A results page
 * changes - articles get written, a shop page drops out, a thin page fills
 * in - so these are asked again after `REJUDGE_AFTER_MS`. A refusal of the
 * searcher (buyer_mismatch: brand, navigation, another city, a service not
 * offered), an existing page and a duplicate stay parked until a person or
 * a profile change says otherwise.
 */
export const TTL_CAUSES: ReadonlySet<string> = new Set(["not_editorial", "needs_page", "thin_serp"]);
/** How long a results-page refusal parks a row. */
export const REJUDGE_AFTER_MS = 30 * 86_400_000;
/**
 * A verdict parks its row within minutes of being bought (the refill parks
 * as it goes). A row whose park stamp is much later than its verdict was
 * taken off the plan by a person after it was judged, and stays where they
 * put it.
 */
const PARKED_BY_VERDICT_MS = 60 * 60_000;

/** A row parked by a results-page refusal that is now older than its TTL. */
export function parkExpired(row: QueueRow, now: number = Date.now()): boolean {
  // A contested refusal (two reads disagreed, lib/keyword-research/
  // opportunity.ts) ages out whatever its cause.
  const contested = (row.opportunity as { contested?: unknown } | null | undefined)?.contested === true;
  if (!isParked(row) || rawStatus(row) !== "rejected" || !(TTL_CAUSES.has(rawCause(row) ?? "") || contested)) return false;
  const checked = Date.parse(String((row.opportunity as { checkedAt?: unknown }).checkedAt ?? ""));
  const parked = Date.parse(String(row.plan_excluded_at));
  if (!Number.isFinite(checked) || !Number.isFinite(parked)) return false;
  return parked - checked <= PARKED_BY_VERDICT_MS && now - checked > REJUDGE_AFTER_MS;
}

/**
 * A parked row the queue may judge again: parked for want of a verdict, or
 * parked by a results-page refusal whose 30 days are up (`TTL_CAUSES`). A
 * refusal of the searcher stays parked - a "no" to who is searching is not
 * undone by the calendar turning - and a row a person took off the plan
 * stays where they put it.
 */
export function isRequalifiable(row: QueueRow, now: number = Date.now()): boolean {
  return isParked(row) && ((rawCause(row) === "unjudged" && rawStatus(row) !== "rejected") || parkExpired(row, now));
}

/** A parked row nothing should touch again without a person. */
export function isParkedForGood(row: QueueRow): boolean {
  return isParked(row) && !isRequalifiable(row);
}

/**
 * A row the refill buys a verdict for when it has no current one: open, or
 * parked only for want of one. A planned row is not: it was approved to get
 * on the calendar, and nothing judges it again.
 */
export function isJudgeable(row: QueueRow): boolean {
  return row.status === "new" || isRequalifiable(row);
}

/** The verdict a pre-qualification row is parked with. */
export function unjudgedVerdict(fingerprint: string): Opportunity {
  return {
    version: OPPORTUNITY_VERSION,
    context: fingerprint,
    checkedAt: new Date().toISOString(),
    status: "pending",
    cause: "unjudged",
    reason: "Stored before topic qualification existed. Judged again when the queue needs topics.",
  };
}

/**
 * Park rows: off the calendar (unwritten entries removed), status `stored`,
 * `plan_excluded_at` stamped, the verdict that parked them saved.
 */
export async function parkKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  verdicts: ReadonlyArray<{ id: string; verdict: Opportunity }>,
): Promise<{ parked: number; entriesRemoved: number }> {
  if (!verdicts.length) return { parked: 0, entriesRemoved: 0 };
  const ids = verdicts.map((v) => v.id);
  const { data: entries, error: readError } = await supabase
    .from("calendar_entries")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("keyword_id", ids)
    .is("article_id", null);
  if (readError) throw new Error(`Could not read calendar entries: ${readError.message}`);
  const entryIds = (entries ?? []).map((e) => e.id as string);
  if (entryIds.length) {
    const { error } = await supabase.from("calendar_entries").delete().in("id", entryIds);
    if (error) throw new Error(`Could not remove calendar entries: ${error.message}`);
  }
  const now = new Date().toISOString();
  let parked = 0;
  for (const { id, verdict } of verdicts) {
    const { error, count } = await supabase
      .from("keywords")
      .update({ status: "stored", plan_excluded_at: now, opportunity: verdict }, { count: "exact" })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .in("status", ["new", "stored", "planned"]);
    if (error) throw new Error(`Could not park keyword: ${error.message}`);
    parked += count ?? 1;
  }
  return { parked, entriesRemoved: entryIds.length };
}

/** A row parked for want of a verdict, now judged good: back in the queue. */
async function unpark(supabase: SupabaseClient, workspaceId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from("keywords")
    .update({ status: "new", plan_excluded_at: null })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .eq("status", "stored");
  if (error) throw new Error(`Could not return keyword to the queue: ${error.message}`);
}

export interface RefillOutcome {
  /** Ready topics after the refill. */
  ready: number;
  target: number;
  judged: number;
  qualified: number;
  parked: number;
  /** Every current verdict, cached or bought, by keyword id. */
  verdicts: Map<string, Opportunity>;
}

/**
 * The spend gate refused a batch part-way through a refill. Still a
 * SpendRefusedError, so every caller that stops on a refusal stops here too;
 * it also carries what the refill held when the refusal came - the cached
 * verdicts and every batch bought and saved before it - so a count taken
 * after the refusal reads those, not the rows as they stood before the pass
 * (the onboarding funnel counted an approval bought in batch one as "spend
 * refused" when batch two was refused, 2026-09-29).
 */
export class RefillRefusedError extends SpendRefusedError {
  constructor(
    refusal: SpendRefusedError,
    /** Every current verdict when the refusal came, cached or bought, by keyword id. */
    readonly verdicts: ReadonlyMap<string, Opportunity>,
    /** Verdicts bought by this refill before the refusal. */
    readonly judged: number,
  ) {
    super(refusal.decision);
  }
}

/**
 * Bring the queue up to `target` ready topics, buying verdicts for the
 * best unjudged candidates only until it gets there.
 *
 * `candidates` come best-first from the caller (the recommender's order:
 * relevance, reach, volume). Each batch is at most QUALIFICATION_LIMIT rows
 * and at most three per topic still needed, and a call buys at most
 * REFILL_MAX_BATCHES batches, so a cron pass on a big pool is bounded. A
 * rejection parks the row with its verdict; a pending verdict is left for
 * the next run; a qualified verdict on a parked-unjudged row returns it to
 * the queue. A spend refusal part-way through throws a RefillRefusedError
 * holding the verdicts gathered until then.
 */
export async function refillQualifiedQueue(
  supabase: SupabaseClient,
  workspaceId: string,
  candidates: ReadonlyArray<QueueRow>,
  context: OpportunityContext,
  options: {
    target: number;
    maxBatches?: number;
    /** What already owns a search, as the caller worked it out (see `qualifyOpportunities`). */
    owners?: readonly IntentLeader[];
    /** A first look: approvals asked twice, spend bounded (see `qualifyOpportunities`). */
    firstLook?: FirstLook;
  },
): Promise<RefillOutcome> {
  const fingerprint = contextKey(context);
  const verdicts = new Map<string, Opportunity>();
  const ready = new Set<string>();
  const unjudged: QueueRow[] = [];
  for (const row of candidates) {
    if (isParkedForGood(row)) continue;
    const cached = readOpportunity(row.opportunity, fingerprint);
    if (cached) {
      verdicts.set(row.id, cached);
      if (cached.status === "qualified" && row.status === "new") ready.add(row.id);
      if (cached.status === "qualified" && isRequalifiable(row)) { await unpark(supabase, workspaceId, row.id); ready.add(row.id); }
      if (cached.status !== "pending" || cached.cause !== "unjudged") continue;
    }
    if (isJudgeable(row)) unjudged.push(row);
  }

  let judged = 0;
  let qualified = 0;
  let parked = 0;
  let batches = 0;
  const maxBatches = options.maxBatches ?? REFILL_MAX_BATCHES;
  while (ready.size < options.target && unjudged.length && batches < maxBatches) {
    const needed = options.target - ready.size;
    const batch = unjudged.splice(0, Math.min(QUALIFICATION_LIMIT, needed * 3));
    batches++;
    const asked: OpportunityCandidate[] = batch.map((row) => ({ id: row.id, term: row.term, source_url: row.source_url, opportunity: null, buyer_fit: row.buyer_fit ?? null, ...(row.unmeasured ? { unmeasured: true } : {}) }));
    let results: Map<string, Opportunity>;
    try {
      results = await qualifyOpportunities(supabase, workspaceId, asked, context, {
        ...(options.owners ? { owners: options.owners } : {}),
        ...(options.firstLook ? { firstLook: options.firstLook } : {}),
      });
    } catch (err) {
      if (err instanceof SpendRefusedError) throw new RefillRefusedError(err, verdicts, judged);
      throw err;
    }
    const toPark: Array<{ id: string; verdict: Opportunity }> = [];
    for (const row of batch) {
      const result = results.get(row.id);
      if (!result) continue;
      judged++;
      verdicts.set(row.id, result);
      if (result.status === "qualified") {
        qualified++;
        if (isRequalifiable(row)) await unpark(supabase, workspaceId, row.id);
        ready.add(row.id);
      } else if (result.status === "rejected") {
        toPark.push({ id: row.id, verdict: result });
      }
    }
    if (toPark.length) parked += (await parkKeywords(supabase, workspaceId, toPark)).parked;
    // A first look that stopped part-way through a batch hit its budget:
    // the next batch would stop before buying anything too.
    if (options.firstLook && batch.some((row) => !results.has(row.id))) break;
  }

  return { ready: ready.size, target: options.target, judged, qualified, parked, verdicts };
}

/**
 * How many ready topics a workspace holds right now, from the table. The
 * cheap check a research job makes before spending on new candidates.
 */
export async function countReady(supabase: SupabaseClient, workspaceId: string, context: OpportunityContext): Promise<number> {
  const { data, error } = await supabase
    .from("keywords")
    .select("id, term, status, opportunity, plan_excluded_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "new")
    .is("plan_excluded_at", null)
    .not("opportunity", "is", null);
  if (error) throw new Error(`Could not count the queue: ${error.message}`);
  const fingerprint = contextKey(context);
  return ((data ?? []) as QueueRow[]).filter((row) => readOpportunity(row.opportunity, fingerprint)?.status === "qualified").length;
}
