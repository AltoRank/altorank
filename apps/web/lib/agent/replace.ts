// ---------------------------------------------------------------------------
// Find-and-replace through the agent API: propose, then maybe write
// ---------------------------------------------------------------------------
//
// One function behind POST /articles/{id}/replace and /articles/bulk-replace.
// The computation is lib/articles/replace.ts (pure); this adds the write, the
// same columns the editor's Save writes (content, title, word_count,
// updated_at), and the proposal envelope. Status is never touched: a replace
// is an edit, and edits do not approve, schedule or publish.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { planReplace, type ReplaceHit } from "@/lib/articles/replace";
import type { Article } from "@/lib/types";
import type { HumanPresentation } from "./envelope";

export const replaceBodySchema = z.object({
  find: z.string().min(1).max(500),
  replace: z.string().max(2000),
  match_case: z.boolean().default(false),
  whole_word: z.boolean().default(false),
  /** True by default: nothing is written until the caller says so. */
  preview_only: z.boolean().default(true),
});

export type ReplaceBody = z.infer<typeof replaceBodySchema>;

/** How many hits the proposal carries in full; the rest are counted. */
const MAX_HITS_RETURNED = 50;

export type ReplaceResultData = {
  article_id: string;
  workspace_id: string;
  title_before: string;
  title_after: string;
  status: Article["status"];
  editor_url: string;
  preview_only: boolean;
  occurrences: number;
  hits: ReplaceHit[];
  hits_truncated: boolean;
  /** True only when the row was actually updated. */
  written: boolean;
  word_count_after: number | null;
};

export type ReplaceResult = {
  data: ReplaceResultData;
  guidance: string;
  human: HumanPresentation;
};

export async function applyReplace(
  supabase: SupabaseClient,
  article: Article,
  body: ReplaceBody,
  baseUrl: string,
): Promise<ReplaceResult> {
  const plan = planReplace(
    { title: article.title, content: article.content },
    { find: body.find, replace: body.replace, match_case: body.match_case, whole_word: body.whole_word },
  );
  const editorUrl = `${baseUrl}/content/${article.id}`;
  const write = !body.preview_only && plan.occurrences > 0;

  if (write) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (plan.content) {
      patch.content = plan.content;
      patch.word_count = plan.word_count;
    }
    if (plan.title !== article.title) patch.title = plan.title;
    const { error } = await supabase
      .from("articles")
      .update(patch)
      .eq("id", article.id)
      .eq("workspace_id", article.workspace_id);
    if (error) throw new Error(error.message);
  }

  const data: ReplaceResultData = {
    article_id: article.id,
    workspace_id: article.workspace_id,
    title_before: article.title,
    title_after: plan.title,
    status: article.status,
    editor_url: editorUrl,
    preview_only: body.preview_only,
    occurrences: plan.occurrences,
    hits: plan.hits.slice(0, MAX_HITS_RETURNED),
    hits_truncated: plan.hits.length > MAX_HITS_RETURNED,
    written: write,
    word_count_after: write ? plan.word_count : null,
  };

  const n = plan.occurrences;
  const guidance =
    n === 0
      ? `No occurrence of "${body.find}" in "${article.title}"${body.match_case ? " (case-sensitive)" : ""}${body.whole_word ? " (whole word)" : ""}. Nothing to change; say so. A match never spans formatting, so text split across bold and plain will not match here - the human can do that one in the editor.`
      : body.preview_only
        ? `Proposal only: ${n} occurrence${n === 1 ? "" : "s"}; nothing changed. Show the human the hits (before → after). If they agree, send the same body with preview_only: false. Status stays ${article.status} either way.`
        : `Written: ${n} occurrence${n === 1 ? "" : "s"} replaced in "${plan.title}". Status is still ${article.status}; nothing was approved or published. The human sees the change at editor_url.`;

  const human: HumanPresentation = {
    title: write ? "Text replaced" : "Proposed replacement",
    summary_instructions:
      "Say what was (or would be) replaced with what, how many times, and in which article. Quote one or two hits as before → after. Never imply the article was published.",
    sections: [
      {
        label: "Change",
        items: [
          { field: "find", label: "Find", value_label: body.find },
          { field: "replace", label: "Replace with", value_label: body.replace || "(nothing)" },
          { field: "occurrences", label: "Occurrences", value_label: String(n) },
          { field: "written", label: "Applied", value_label: write ? "Yes" : "No, proposal only" },
          { field: "status", label: "Article status", value_label: article.status, description: "Unchanged by this call." },
        ],
      },
    ],
  };

  return { data, guidance, human };
}
