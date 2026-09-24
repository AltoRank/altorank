// ---------------------------------------------------------------------------
// Search Console queries become keyword rows
// ---------------------------------------------------------------------------
//
// The keyword pool `recommendKeywords` scores is the `keywords` table. Search
// Console rows in `analytics_metrics` only ever *decorated* that pool: a query
// with impressions added to the score of a keyword row that already carried
// the same term, and a query with no such row was invisible.
//
// On production this meant the altorank.co workspace held, in its own
// database, "rankingcoach alternative" at 215 impressions and position 28 -
// striking distance, the single best thing the site could write to - while
// the picker, seeing only heading-derived and profile-derived rows, drafted
// "Free People Search 2026". DataForSEO's ranked_keywords index did not know
// the domain at all (0 rows; DR 12, four months old), so `source = 'ranked'`
// never fired for it either. Search Console is the one source that sees a
// young site, and it was the one source that could not reach the pool.
//
// This turns query rows into keyword rows, with the position as a ranking
// row so the recommender's striking-distance branch fires on the same run.
//
// Only the `query` shape is read (query set, page_url null), as the query
// partition lib/gsc/read.ts hands back - lib/gsc/analysis.ts explains why the
// four shapes must never be mixed. Everything numeric is aggregated over the
// window, impression-weighted for position.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyIntent } from "@/lib/seo/intent";
import { isBrandTerm } from "@/lib/keyword-research/seeds";
import type { GscShapes } from "./analysis";
import { readGsc } from "./read";

/** Search Console keeps 16 months; the recommender's own lookback is 90 days. */
export const SEED_LOOKBACK_DAYS = 90;
/** Below this the position is noise: a handful of impressions can sit anywhere. */
export const SEED_MIN_IMPRESSIONS = 10;
/** Past page four Google is testing the page, not ranking it. */
export const SEED_MAX_POSITION = 40;
/** Enough to feed a month's plan; the rest is still in analytics_metrics. */
export const SEED_LIMIT = 50;

export interface QueryRow {
  query: string | null;
  page_url: string | null;
  impressions: number | null;
  clicks: number | null;
  avg_position: number | null;
}

export interface SearchConsoleSeed {
  term: string;
  impressions: number;
  clicks: number;
  /** Impression-weighted mean over the window, rounded to a whole position. */
  position: number;
}

export interface SeedSelection {
  seeds: SearchConsoleSeed[];
  /** Pure brand navigation, kept out: nobody writes an article to their own name. */
  brand: number;
  /** Queries under the impression floor or past the position ceiling. */
  weak: number;
}

/**
 * The pure part: the query partition in, the seeds worth storing out.
 * Exported so the thresholds are testable without a database.
 *
 * It takes `{ query }` and nothing else, so it cannot be handed a query_page
 * row: one carries the same impressions again for each page, and summing both
 * shapes counts every impression twice.
 */
export function selectSearchConsoleSeeds(
  gsc: GscShapes<QueryRow, "query">,
  domain: string,
  opts?: { minImpressions?: number; maxPosition?: number; limit?: number },
): SeedSelection {
  const minImpressions = opts?.minImpressions ?? SEED_MIN_IMPRESSIONS;
  const maxPosition = opts?.maxPosition ?? SEED_MAX_POSITION;
  const limit = opts?.limit ?? SEED_LIMIT;

  const byTerm = new Map<string, { term: string; impressions: number; clicks: number; weighted: number }>();
  for (const r of gsc.query) {
    if (!r.query) continue;
    const term = r.query.trim().toLowerCase();
    if (!term) continue;
    const impressions = r.impressions ?? 0;
    const agg = byTerm.get(term) ?? { term, impressions: 0, clicks: 0, weighted: 0 };
    agg.impressions += impressions;
    agg.clicks += r.clicks ?? 0;
    // Position is only meaningful weighted by how often it was observed: a
    // day at position 3 on one impression must not pull a month at 30.
    if (r.avg_position !== null) agg.weighted += r.avg_position * impressions;
    byTerm.set(term, agg);
  }

  let brand = 0;
  let weak = 0;
  const seeds: SearchConsoleSeed[] = [];
  for (const agg of byTerm.values()) {
    // The house rule (keyword-research/seeds.ts): "altorank" is navigation
    // and is dropped; "altorank pricing" evaluates a purchase and is kept -
    // whether a page already owns it is the recommender's call, not this one.
    if (isBrandTerm(agg.term, domain, [])) {
      brand++;
      continue;
    }
    if (agg.impressions < minImpressions) {
      weak++;
      continue;
    }
    const position = agg.impressions > 0 ? Math.round(agg.weighted / agg.impressions) : 0;
    if (position === 0 || position > maxPosition) {
      weak++;
      continue;
    }
    seeds.push({ term: agg.term, impressions: agg.impressions, clicks: agg.clicks, position });
  }

  // Most impressions first: that is the demand Google has already measured
  // for this site, which no volume estimate can improve on.
  seeds.sort((a, b) => b.impressions - a.impressions || a.position - b.position);
  return { seeds: seeds.slice(0, limit), brand, weak };
}

export interface SeedResult {
  /** Seeds that passed the thresholds, before dedupe against the pool. */
  candidates: number;
  /** New keyword rows written. */
  inserted: number;
  /** Seeds already in the pool by term; left as they were. */
  existing: number;
  /** Existing gsc-source rows given a fresh ranking row from this window. */
  refreshed: number;
  brand: number;
  /** One line for a phase log or a layer. */
  detail: string;
  terms: string[];
}

/**
 * Read the workspace's Search Console query rows for the lookback window and
 * store the ones worth writing to as keyword rows, each with a ranking row at
 * the observed position.
 *
 * Idempotent by term: a query already in the pool - from any source - is left
 * alone. Its impressions still reach the recommender the way they always did,
 * through the join in recommendKeywords.
 */
export async function seedKeywordsFromSearchConsole(
  supabase: SupabaseClient,
  workspace: { id: string; domain: string | null; language?: string | null },
  opts?: { lookbackDays?: number; minImpressions?: number; maxPosition?: number; limit?: number; now?: Date },
): Promise<SeedResult> {
  const empty = (detail: string): SeedResult => ({ candidates: 0, inserted: 0, existing: 0, refreshed: 0, brand: 0, detail, terms: [] });
  if (!workspace.domain) return empty("no domain to read Search Console for");
  // A seeding step must never cost a run its keywords phase: the analysis
  // that ran before it is already stored. Whatever breaks here is reported
  // in the detail line and the caller carries on.
  try {
    return await seed(supabase, workspace, opts, empty);
  } catch (err) {
    return empty(`Search Console seeding failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function seed(
  supabase: SupabaseClient,
  workspace: { id: string; domain: string | null; language?: string | null },
  opts: { lookbackDays?: number; minImpressions?: number; maxPosition?: number; limit?: number; now?: Date } | undefined,
  empty: (detail: string) => SeedResult,
): Promise<SeedResult> {
  if (!workspace.domain) return empty("no domain to read Search Console for");

  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - (opts?.lookbackDays ?? SEED_LOOKBACK_DAYS) * 86_400_000).toISOString().slice(0, 10);

  // Every query row in the window. The read used to stop at PostgREST's first
  // 1,000 rows, which on a site with a few dozen queries a day is about a
  // month of a 90-day window, summed as if it were all of it.
  let gsc: GscShapes<QueryRow, "query">;
  try {
    gsc = await readGsc(supabase, {
      workspaceId: workspace.id,
      shapes: ["query"],
      since,
      columns: ["impressions", "clicks", "avg_position"],
    });
  } catch (error) {
    return empty(`could not read Search Console rows: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rows = gsc.query;
  if (!rows.length) return empty("no Search Console queries synced for this window");

  const selection = selectSearchConsoleSeeds(gsc, workspace.domain, opts);
  if (!selection.seeds.length) {
    return { ...empty(`Search Console has ${rows.length} query rows but none at ${SEED_MIN_IMPRESSIONS}+ impressions inside the top ${SEED_MAX_POSITION}`), brand: selection.brand };
  }

  const { data: existingRows } = await supabase.from("keywords").select("id, term, source").eq("workspace_id", workspace.id);
  const byTerm = new Map(
    ((existingRows ?? []) as Array<{ id: string; term: string; source: string | null }>).map((k) => [k.term.trim().toLowerCase(), k]),
  );
  const checkedAt = now.toISOString();

  // Terms this seeder stored on an earlier run get their position brought up
  // to date from the same window, as a new ranking row. This is what makes a
  // gsc term's position real on the keywords page night after night: Search
  // Console reports it for free, so cron/serp does not buy a SERP for these
  // (it skips source = 'gsc'). Terms from any other source are left to the
  // tracker they already have.
  const refreshRows = selection.seeds.flatMap((s) => {
    const row = byTerm.get(s.term);
    return row && row.source === "gsc" ? [{ keyword_id: row.id, position: s.position, url: null, checked_at: checkedAt }] : [];
  });
  if (refreshRows.length) await supabase.from("keyword_rankings").insert(refreshRows);

  const fresh = selection.seeds.filter((s) => !byTerm.has(s.term));
  const existing = selection.seeds.length - fresh.length;
  if (!fresh.length) {
    return {
      candidates: selection.seeds.length,
      inserted: 0,
      existing,
      refreshed: refreshRows.length,
      brand: selection.brand,
      detail:
        `${selection.seeds.length} Search Console ${plural(selection.seeds.length, "query", "queries")} already in the pool` +
        (refreshRows.length ? `, ${refreshRows.length} ${plural(refreshRows.length, "position", "positions")} refreshed` : ""),
      terms: [],
    };
  }

  const language = workspace.language ?? "en";
  const rowsToInsert = fresh.map((s) => ({
    workspace_id: workspace.id,
    term: s.term,
    // Search Console reports impressions, not searches. Volume stays
    // unmeasured rather than guessed; the recommender scores null
    // conservatively and adds the impressions on top.
    volume: null,
    difficulty: null,
    cpc: null,
    intent: classifyIntent(s.term, language).intent,
    status: "new",
    source: "gsc",
    source_type: "gsc",
    source_ref: "search console",
  }));
  const { data: inserted, error: insertError } = await supabase.from("keywords").insert(rowsToInsert).select("id, term");
  if (insertError) return { ...empty(`could not store Search Console keywords: ${insertError.message}`), candidates: selection.seeds.length, refreshed: refreshRows.length, brand: selection.brand };

  const idByTerm = new Map(((inserted ?? []) as Array<{ id: string; term: string }>).map((r) => [r.term.trim().toLowerCase(), r.id]));
  const rankings = fresh
    .map((s) => ({ keyword_id: idByTerm.get(s.term), position: s.position, url: null, checked_at: checkedAt }))
    .filter((r): r is { keyword_id: string; position: number; url: null; checked_at: string } => Boolean(r.keyword_id));
  if (rankings.length) await supabase.from("keyword_rankings").insert(rankings);

  const close = fresh.filter((s) => s.position >= 11 && s.position <= 20).length;
  return {
    candidates: selection.seeds.length,
    inserted: fresh.length,
    existing,
    refreshed: refreshRows.length,
    brand: selection.brand,
    detail:
      `${fresh.length} from Search Console, ${plural(fresh.length, "query", "queries")} the site already appears for` +
      (close ? `, ${close} in striking distance` : "") +
      (existing ? ` (${existing} already in the pool)` : "") +
      (refreshRows.length ? `, ${refreshRows.length} ${plural(refreshRows.length, "position", "positions")} refreshed` : ""),
    terms: fresh.map((s) => s.term),
  };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
