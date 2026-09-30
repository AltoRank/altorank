// ---------------------------------------------------------------------------
// Why a first look planned nothing
// ---------------------------------------------------------------------------
//
// On 2026-09-28 both real signups' first looks planned nothing: one site had
// 144 searches judged and the other 236, and not one qualified. The run said
// "No keyword clear enough to plan yet", the row said `partial`, and nobody
// could tell from either which stage had emptied the pool without querying
// the keyword rows by hand. This reads it off the rows the run already wrote:
// every keyword row keeps its verdict (`opportunity`, lib/keyword-research/
// opportunity.ts), with a cause, so the stage that removed the candidates is
// a tally, not a guess. No provider call.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/supabase/read-all";
import { causeLabel } from "@/lib/keyword-research/opportunity";
import type { EmptyPool } from "./events";

/** A keyword row's verdict, as far as this reads it. */
export type VerdictRow = { status?: string | null; cause?: string | null };

function tally(rows: readonly VerdictRow[], status: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.status !== status) continue;
    const cause = r.cause || "unspecified";
    out[cause] = (out[cause] ?? 0) + 1;
  }
  return out;
}

function largest(counts: Record<string, number>): string | null {
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top ? top[0] : null;
}

function inWords(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cause, n]) => `${n} ${causeLabel(cause)}`)
    .join(", ");
}

/**
 * The stage and the tally, from the verdicts on the site's keyword rows.
 * Pure, so the stage rule is tested without a database.
 *
 * A row with no verdict at all counts as a pending one with cause
 * `unjudged`: it was in the pool and nothing judged it, which is its own
 * answer to "why was nothing planned".
 */
export function describeEmptyPool(rows: readonly VerdictRow[]): EmptyPool {
  const verdicts = rows.map((r) => (r.status ? r : { status: "pending", cause: "unjudged" }));
  const qualified = verdicts.filter((r) => r.status === "qualified").length;
  const rejected = tally(verdicts, "rejected");
  const pending = tally(verdicts, "pending");
  const keywords = rows.length;

  if (keywords === 0) {
    return {
      stage: "keywords",
      cause: null,
      keywords: 0,
      qualified: 0,
      rejected,
      pending,
      summary: "Keyword research found nothing to judge for this site.",
    };
  }
  if (qualified > 0) {
    return {
      stage: "planning",
      cause: null,
      keywords,
      qualified,
      rejected,
      pending,
      summary: `${qualified} of ${keywords} searches qualified and the planner placed none of them.`,
    };
  }
  const cause = largest(rejected) ?? largest(pending);
  const parts = [
    Object.keys(rejected).length ? `rejected: ${inWords(rejected)}` : "",
    Object.keys(pending).length ? `undecided: ${inWords(pending)}` : "",
  ].filter(Boolean);
  return {
    stage: "qualification",
    cause,
    keywords,
    qualified: 0,
    rejected,
    pending,
    summary: `None of ${keywords} searches qualified${cause ? `; the largest group: ${causeLabel(cause)}` : ""} (${parts.join("; ")}).`,
  };
}

/**
 * Read the site's keyword verdicts and describe the empty pool. Every row,
 * paged: a site with 1,400 rows would otherwise be summed from its first
 * thousand and reported as if whole.
 */
export async function readEmptyPool(supabase: SupabaseClient, workspaceId: string): Promise<EmptyPool> {
  // Aliased: `keywords.status` is the row's own lifecycle (new, planned,
  // stored), not the verdict.
  const rows = await readAllPages<{ verdict: string | null; cause: string | null }>(
    "the keyword verdicts for the empty-pool report",
    (from, to, count) =>
      supabase
        .from("keywords")
        .select("id, verdict:opportunity->>status, cause:opportunity->>cause", { count })
        .eq("workspace_id", workspaceId)
        .order("id", { ascending: true })
        .range(from, to),
  );
  return describeEmptyPool(rows.map((r) => ({ status: r.verdict, cause: r.cause })));
}
