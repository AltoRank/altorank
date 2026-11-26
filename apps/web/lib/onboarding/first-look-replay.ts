// ---------------------------------------------------------------------------
// What a first look read, kept so the run can be replayed without paying
// ---------------------------------------------------------------------------
//
// A first look's results pages lived only in memory (`firstLook.serps`,
// ./pipeline.ts). When four signups in one evening planned nothing
// (2026-11-16), the only way to see what the planner had been shown was to
// buy every page again, on pages that had since changed. One row per run now
// holds what the planner decided on: the topics each ask returned, and every
// results page read, compact (the search, the page-type reading, the judged
// results with their kinds).
//
// Server only (migration 123): written with the service role, no policy. The
// rows hold a site's searches and public search results, nothing a customer
// typed. `lib/evals` replays the same shape from files (first-look.ts there).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SuggestedTopic } from "@/lib/keyword-research/first-look-topics";
import type { SerpData } from "@/lib/seo/brief-data";
import type { FirstLookPlanResult, FirstLookRead } from "./first-look-plan";

export const FIRST_LOOK_REPLAY_VERSION = 1;

/** The row, as stored. */
export interface FirstLookReplayRow {
  run_id: string;
  workspace_id: string;
  version: number;
  language_code: string;
  location_code: number;
  outcome: string;
  rung: string | null;
  asked: { suggested: SuggestedTopic[]; secondAsk: SuggestedTopic[] };
  pages: FirstLookRead[];
}

export function replayRow(input: {
  runId: string;
  workspaceId: string;
  languageCode: string;
  locationCode: number;
  result: Pick<FirstLookPlanResult, "outcome" | "summary" | "reads" | "asked">;
}): FirstLookReplayRow {
  return {
    run_id: input.runId,
    workspace_id: input.workspaceId,
    version: FIRST_LOOK_REPLAY_VERSION,
    language_code: input.languageCode,
    location_code: input.locationCode,
    outcome: input.result.outcome,
    rung: input.result.summary.rung ?? null,
    asked: input.result.asked,
    pages: input.result.reads,
  };
}

/** How long the write may take before the run goes on without it. */
export const REPLAY_SAVE_MS = 5_000;

/**
 * Keep the run's reads. Never throws and never holds the run: a database
 * without migration 123, a write that fails, or one that does not answer
 * within REPLAY_SAVE_MS costs the replay and nothing else. Bounded because
 * a save that never answered held a production first look for 25 minutes
 * (2026-10-15), and this one sits between the plan and the draft.
 */
export async function saveFirstLookReplay(db: SupabaseClient, row: FirstLookReplayRow, timeoutMs = REPLAY_SAVE_MS): Promise<boolean> {
  if (!row.asked.suggested.length && !row.asked.secondAsk.length && !row.pages.length) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { error } = await Promise.race([
      Promise.resolve(db.from("first_look_replays").upsert(row, { onConflict: "run_id" })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (error) {
      console.warn(`[first look] could not keep the run's results pages: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[first look] could not keep the run's results pages: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** A stored page as the planner's `serp` option hands one back. */
export function serpOfRead(read: Pick<FirstLookRead, "results">): SerpData {
  return {
    organic: read.results.map((r) => ({ rank: r.rank, title: r.title, url: r.url, description: r.description, domain: r.domain, wordCount: null })),
    peopleAlsoAsk: [],
    aiOverview: null,
  };
}

/**
 * The planner's `ask` and `serp` options answered from a stored run: the
 * topics as each ask returned them, and the pages by search. A search the
 * run never read throws, as a provider that did not answer would.
 */
export function replayOf(stored: Pick<FirstLookReplayRow, "asked" | "pages">): {
  ask: (operation: string) => Promise<string | null>;
  serp: (term: string) => Promise<SerpData>;
} {
  const pages = new Map(stored.pages.map((p) => [p.query, p]));
  return {
    ask: async (operation) => {
      const topics = operation.endsWith("second-ask") ? stored.asked.secondAsk : stored.asked.suggested;
      return topics.length ? JSON.stringify({ topics }) : null;
    },
    serp: async (term) => {
      const page = pages.get(term);
      if (!page) throw new Error(`No stored results page for "${term}".`);
      return serpOfRead(page);
    },
  };
}
