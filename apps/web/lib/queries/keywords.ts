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
