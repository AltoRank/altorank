import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Article } from "@/lib/types";

export async function getArticles(
  workspaceId?: string,
  status?: string,
  sort?: string,
): Promise<Article[]> {
  const supabase = await createClient();
  let query = supabase.from("articles").select("*");

  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  if (status) query = query.eq("status", status);

  if (sort === "title") {
    query = query.order("title", { ascending: true });
  } else if (sort === "score") {
    query = query.order("seo_score", { ascending: false });
  } else if (sort === "volume") {
    query = query.order("volume", { ascending: false });
  } else {
    query = query.order("updated_at", { ascending: false });
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Article[];
}

/**
 * Deduplicated per request: the editor route's `generateMetadata` wants the
 * title and the page wants the whole row, so both called this on every load.
 */
export const getArticle = cache(async function getArticle(
  id: string,
): Promise<Article | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("articles")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return null;
  return data as Article;
});

/**
 * The dashboard's recent-articles strip.
 *
 * Takes the workspace for the same reason `getArticles` does: it renders one
 * row below a list that is already scoped, and unscoped it filled that strip
 * with another client's drafts while the page said it was about this one.
 */
export async function getRecentArticles(
  limit: number = 6,
  workspaceId?: string,
): Promise<Article[]> {
  const supabase = await createClient();
  let query = supabase
    .from("articles")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data, error } = await query;

  if (error) throw new Error(error.message);
  return (data ?? []) as Article[];
}
