import { createClient } from "@/lib/supabase/server";
import type { Keyword, KeywordRanking } from "@/lib/types";
import { rollupSourceYields, type KeywordSourceYields } from "@/lib/keywords/yields";

export async function getKeywords(
  workspaceId?: string,
  status?: string,
  intent?: string,
): Promise<Keyword[]> {
  const supabase = await createClient();
  let query = supabase.from("keywords").select("*").order("volume", { ascending: false });

  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  if (status) query = query.eq("status", status);
  if (intent) query = query.eq("intent", intent);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Keyword[];
}

export async function getKeywordRankings(keywordId: string): Promise<KeywordRanking[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("keyword_rankings")
    .select("*")
    .eq("keyword_id", keywordId)
    .order("checked_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as KeywordRanking[];
}

/** What a planner card shows about its keyword: the object, not just the term. */
export type PlannerKeyword = Pick<
  Keyword,
  "id" | "workspace_id" | "term" | "volume" | "difficulty" | "intent" | "article_type" | "article_subtype" | "expected_length" | "instructions" | "quality_questions"
>;

/**
 * The keyword rows behind a set of calendar entries, scoped to the workspace
 * the planner is showing. Always by workspace as well as by id: an id list
 * alone would let a stale entry pull a keyword from a sibling site.
 */
export async function getPlannerKeywords(workspaceId: string, keywordIds: string[]): Promise<PlannerKeyword[]> {
  const ids = [...new Set(keywordIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("keywords")
    .select("id, workspace_id, term, volume, difficulty, intent, article_type, article_subtype, expected_length, instructions, quality_questions")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []) as PlannerKeyword[];
}

/**
 * What each keyword source produced for one workspace. Three scoped reads,
 * one arithmetic pass (lib/keywords/yields.ts) so the dashboard and its tests
 * agree on what "written" and "scheduled" mean.
 */
export async function getKeywordSourceYields(workspaceId: string): Promise<KeywordSourceYields> {
  const supabase = await createClient();
  const [kw, art, cal] = await Promise.all([
    supabase.from("keywords").select("id, source_type, source_ref").eq("workspace_id", workspaceId),
    supabase.from("articles").select("keyword_id").eq("workspace_id", workspaceId).not("keyword_id", "is", null),
    supabase
      .from("calendar_entries")
      .select("keyword_id")
      .eq("workspace_id", workspaceId)
      .in("status", ["queue", "scheduled"])
      .is("article_id", null),
  ]);
  if (kw.error) throw new Error(kw.error.message);
  return rollupSourceYields(
    (kw.data ?? []) as Array<{ id: string; source_type: string | null; source_ref: string | null }>,
    ((art.data ?? []) as Array<{ keyword_id: string | null }>).map((a) => a.keyword_id),
    ((cal.data ?? []) as Array<{ keyword_id: string | null }>).map((c) => c.keyword_id),
  );
}

export type LatestRanking = Pick<KeywordRanking, "position" | "url" | "checked_at">;

/**
 * The newest tracked position for each keyword, from the rank cron's history.
 *
 * `keyword_rankings` has no workspace column: it hangs off the keyword, so the
 * ids come from a list that was already scoped and this only narrows further.
 * Read newest-first in pages and stop as soon as every keyword has answered,
 * because a site tracking two hundred terms for three months holds eighteen
 * thousand rows here and PostgREST hands back the first thousand without a
 * word about the rest.
 */
export async function getLatestRankings(keywordIds: string[]): Promise<Map<string, LatestRanking>> {
  const ids = [...new Set(keywordIds.filter(Boolean))];
  const out = new Map<string, LatestRanking>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("keyword_rankings")
      .select("keyword_id, position, url, checked_at")
      .in("keyword_id", ids)
      .order("checked_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ keyword_id: string; position: number | null; url: string | null; checked_at: string }>) {
      if (!out.has(r.keyword_id)) out.set(r.keyword_id, { position: r.position, url: r.url, checked_at: r.checked_at });
    }
    if ((data ?? []).length < PAGE || out.size >= ids.length) return out;
  }
}

export type KeywordRationale = { articleId: string; reasons: string[] };

/**
 * Why the queue wrote about each keyword, from the article it produced.
 * `selection_reasons` is captured at selection time (migration 022) and never
 * recomputed, so this is the reasoning as it was, not as it would be now.
 */
export async function getSelectionReasonsByKeyword(workspaceId: string): Promise<Map<string, KeywordRationale>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("articles")
    .select("id, keyword_id, selection_reasons")
    .eq("workspace_id", workspaceId)
    .not("keyword_id", "is", null)
    .not("selection_reasons", "is", null);
  if (error) throw new Error(error.message);
  const out = new Map<string, KeywordRationale>();
  for (const a of (data ?? []) as Array<{ id: string; keyword_id: string; selection_reasons: unknown }>) {
    const reasons = Array.isArray(a.selection_reasons) ? a.selection_reasons.filter((r): r is string => typeof r === "string") : [];
    if (reasons.length && !out.has(a.keyword_id)) out.set(a.keyword_id, { articleId: a.id, reasons });
  }
  return out;
}
