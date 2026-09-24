import { createClient } from "@/lib/supabase/server";
import { readGsc } from "@/lib/gsc/read";
import {
  cpcIndex,
  estimateOrganicValue,
  sumOrganicValues,
  type ClickRow,
  type OrganicValue,
} from "@/lib/analytics/value";

/** The window every value surface uses, matching the traffic chart. */
export const VALUE_DAYS = 30;

export type TrafficValue = OrganicValue & { days: number };

function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** PostgREST `ilike` treats % and _ as wildcards; a keyword is a literal. */
function literalPattern(term: string): string {
  return term.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * What the last 30 days of organic clicks would have cost as ads.
 *
 * Reads the query-level Search Console rows (the ones carrying `query`; the
 * page-level rows carry `article_id` instead and would double every click)
 * and prices each query with the CPC research stored for that term in the
 * same workspace. Terms are matched within a workspace, never across: the
 * same phrase costs different money in Milan and Manchester, and a term in
 * one client's research must not price another client's traffic.
 *
 * With no workspace the account is summed per site, so the all-workspaces
 * dashboard can show one figure with an honest coverage beside it.
 */
export async function getTrafficValue(
  workspaceId?: string,
  days = VALUE_DAYS,
): Promise<TrafficValue> {
  const supabase = await createClient();
  const start = windowStart(days);

  let keywordQuery = supabase
    .from("keywords")
    .select("workspace_id, term, cpc")
    .not("cpc", "is", null);
  if (workspaceId) keywordQuery = keywordQuery.eq("workspace_id", workspaceId);

  // Query rows, and only query rows. `.not("query","is",null)` also matches
  // the (query, page) shape the sync writes alongside them, so both the euro
  // figure and the "covers X% of N clicks" line under it were about twice
  // what Search Console reported (lib/gsc/analysis.ts). The query partition
  // from lib/gsc/read.ts is exactly the query rows, all of them: this read
  // also used to stop at PostgREST's first 1,000 rows of the window.
  const [{ data: keywords }, gsc] = await Promise.all([
    keywordQuery,
    readGsc(supabase, {
      workspaceId: workspaceId ?? null,
      shapes: ["query"],
      since: start,
      columns: ["workspace_id", "clicks"],
    // A failed read prices nothing, as it always has here: the figure shows
    // its unmeasured dash rather than taking the dashboard down with it.
    }).catch(() => ({ query: [] })),
  ]);

  type KeywordRow = { workspace_id: string; term: string; cpc: number | string | null };

  const keywordsByWorkspace = new Map<string, KeywordRow[]>();
  for (const k of (keywords ?? []) as KeywordRow[]) {
    const list = keywordsByWorkspace.get(k.workspace_id) ?? [];
    list.push(k);
    keywordsByWorkspace.set(k.workspace_id, list);
  }

  const rowsByWorkspace = new Map<string, ClickRow[]>();
  for (const m of gsc.query) {
    const list = rowsByWorkspace.get(m.workspace_id) ?? [];
    list.push({ term: m.query, clicks: m.clicks });
    rowsByWorkspace.set(m.workspace_id, list);
  }

  const parts = [...rowsByWorkspace.entries()].map(([ws, rows]) =>
    estimateOrganicValue(rows, cpcIndex(keywordsByWorkspace.get(ws) ?? [])),
  );

  return { ...sumOrganicValues(parts), days };
}

/**
 * What one live article's clicks would have cost as ads.
 *
 * Search Console attributes clicks to pages, not to the queries that landed
 * on them, so the page-level rows for this article are priced with the CPC
 * of its target keyword. That is a simplification stated on the surface:
 * an article ranks for more than its one keyword, and the number is the
 * value of its traffic *at the price of the term it was written for*.
 *
 * Null when the article has no synced rows, or its keyword has no CPC on
 * file. A draft has neither and should not be asked.
 */
export async function getArticleValue(
  articleId: string,
  workspaceId: string,
  keyword: string | null,
  days = VALUE_DAYS,
): Promise<TrafficValue> {
  const supabase = await createClient();
  const start = windowStart(days);

  // Page rows, as the docstring above says. An article id is stamped on the
  // page shape *and* on the (query, page) shape, so an `article_id` filter
  // alone doubled every article's traffic value.
  const metricRead = readGsc(supabase, {
    workspaceId,
    shapes: ["page"],
    article: articleId,
    since: start,
    columns: ["clicks"],
  }).catch(() => ({ page: [] }));

  const keywordQuery = keyword
    ? supabase
        .from("keywords")
        .select("term, cpc")
        .eq("workspace_id", workspaceId)
        .ilike("term", literalPattern(keyword))
        .not("cpc", "is", null)
    : Promise.resolve({ data: [] as Array<{ term: string; cpc: number | string | null }> });

  const [gsc, { data: keywords }] = await Promise.all([metricRead, keywordQuery]);

  const rows: ClickRow[] = gsc.page.map((m) => ({
    term: keyword,
    clicks: m.clicks,
  }));

  return {
    ...estimateOrganicValue(rows, cpcIndex((keywords ?? []) as Array<{ term: string; cpc: number | string | null }>)),
    days,
  };
}
