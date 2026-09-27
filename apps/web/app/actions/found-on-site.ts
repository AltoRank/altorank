"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { undoFoundOnSite } from "@/lib/found-on-site/undo";

/**
 * "That is not my article." Puts an article the nightly check marked live on
 * the customer's site back as it was, and never matches that page to it again
 * (lib/found-on-site/undo.ts). The caller's own client: RLS decides whether
 * they may change this article.
 */
export async function notFoundOnSite(articleId: string) {
  await requireAuth();
  const supabase = await createClient();
  const result = await undoFoundOnSite(supabase, articleId);
  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
  return result;
}
