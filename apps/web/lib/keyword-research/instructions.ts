// ---------------------------------------------------------------------------
// Keyword instructions: the person's standing brief to every research prompt
// ---------------------------------------------------------------------------
//
// `workspace_output_settings.global_keyword_prompt` has existed since 049 and
// nothing read it. It is the one place a person can say "we only sell in the
// UK", "never target our own brand name", "prefer questions"; every prompt a
// model sees during research starts with it.

import type { SupabaseClient } from "@supabase/supabase-js";

export const KEYWORD_INSTRUCTIONS_MAX = 2000;

export async function readKeywordInstructions(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const { data } = await supabase
    .from("workspace_output_settings")
    .select("global_keyword_prompt")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return ((data?.global_keyword_prompt as string | null) ?? "").trim();
}

/**
 * The prompt with the person's instructions in front of it. Verbatim, in a
 * labelled block, so the model reads them as a brief rather than as more
 * of our own text.
 */
export function withInstructions(instructions: string, prompt: string): string {
  const clean = instructions.trim();
  if (!clean) return prompt;
  return `KEYWORD INSTRUCTIONS FROM THE SITE OWNER (follow these first):\n${clean}\n\n${prompt}`;
}
