import type { SupabaseClient } from "@supabase/supabase-js";

/** Standing article rules can change required evidence, independently of style. */
export function effectiveDraftInstructions(globalInstructions?: string | null, instructions?: string | null): string | null {
  const standing = globalInstructions?.trim();
  const article = instructions?.trim();
  return [standing ? `Standing instructions:\n${standing}` : null, article ? `Article instructions:\n${article}` : null].filter(Boolean).join("\n\n") || null;
}

/** A missing setting means no rules; a failed read must never mean the same. */
export async function loadGlobalDraftInstructions(db: SupabaseClient, workspaceId: string): Promise<string | null> {
  const result = await db.from("workspace_output_settings").select("global_article_prompt").eq("workspace_id", workspaceId).maybeSingle();
  if (result.error) throw new Error("Standing article instructions could not be loaded.");
  return result.data?.global_article_prompt?.trim() || null;
}
