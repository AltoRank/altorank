import { createClient } from "@/lib/supabase/server";
import type { Keyword, KeywordRanking } from "@/lib/types";

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
