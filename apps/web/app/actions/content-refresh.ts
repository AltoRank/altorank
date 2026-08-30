"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { detectDecay, type DecayingArticle } from "@/lib/seo/decay";

/**
 * Get articles with declining rankings for a workspace.
 */
export async function getDecayingArticles(
  workspaceId: string,
): Promise<DecayingArticle[]> {
  const supabase = await createClient();
  return detectDecay(supabase, workspaceId);
}

/**
 * Refresh a decaying article — archives the old one and creates
 * a new draft for the same keyword, linked via replaces_article_id.
 */
export async function refreshArticle(articleId: string) {
  const supabase = await createClient();

  // Fetch the original article
  const { data: original, error } = await supabase
    .from("articles")
    .select("*")
    .eq("id", articleId)
    .single();

  if (error || !original) throw new Error("Article not found");

  // Archive the original
  await supabase
    .from("articles")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", articleId);

  // Create a new draft linked to the original
  const slug = original.slug + "-v2";
  const { data: newArticle, error: createError } = await supabase
    .from("articles")
    .insert({
      workspace_id: original.workspace_id,
      title: original.title,
      slug,
      keyword: original.keyword,
      status: "draft",
      replaces_article_id: articleId,
      ai_provider: original.ai_provider,
    })
    .select("id")
    .single();

  if (createError) throw new Error(createError.message);

  revalidatePath("/articles");

  return { newArticleId: newArticle.id };
}
