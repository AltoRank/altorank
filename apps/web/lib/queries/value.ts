import { createClient } from "@/lib/supabase/server";
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

  let metricQuery = supabase
    .from("analytics_metrics")
    .select("workspace_id, query, clicks")
    .eq("source", "gsc")
    .gte("metric_date", start)
    .not("query", "is", null);
  if (workspaceId) metricQuery = metricQuery.eq("workspace_id", workspaceId);

  const [{ data: keywords }, { data: metrics }] = await Promise.all([keywordQuery, metricQuery]);

  type KeywordRow = { workspace_id: string; term: string; cpc: number | string | null };
  type MetricRow = { workspace_id: string; query: string | null; clicks: number | null };

  const keywordsByWorkspace = new Map<string, KeywordRow[]>();
  for (const k of (keywords ?? []) as KeywordRow[]) {
    const list = keywordsByWorkspace.get(k.workspace_id) ?? [];
    list.push(k);
    keywordsByWorkspace.set(k.workspace_id, list);
  }

  const rowsByWorkspace = new Map<string, ClickRow[]>();
  for (const m of (metrics ?? []) as MetricRow[]) {
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

  const metricQuery = supabase
    .from("analytics_metrics")
    .select("clicks")
    .eq("workspace_id", workspaceId)
    .eq("article_id", articleId)
    .eq("source", "gsc")
    .gte("metric_date", start);

  const keywordQuery = keyword
    ? supabase
        .from("keywords")
        .select("term, cpc")
        .eq("workspace_id", workspaceId)
        .ilike("term", literalPattern(keyword))
        .not("cpc", "is", null)
    : Promise.resolve({ data: [] as Array<{ term: string; cpc: number | string | null }> });

  const [{ data: metrics }, { data: keywords }] = await Promise.all([metricQuery, keywordQuery]);

  const rows: ClickRow[] = ((metrics ?? []) as Array<{ clicks: number | null }>).map((m) => ({
    term: keyword,
    clicks: m.clicks,
  }));

  return {
    ...estimateOrganicValue(rows, cpcIndex((keywords ?? []) as Array<{ term: string; cpc: number | string | null }>)),
    days,
  };
}
