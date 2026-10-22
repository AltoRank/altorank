// ---------------------------------------------------------------------------
// An operator rewrites one draft in place
// ---------------------------------------------------------------------------
//
// A signup's first draft, 2026-10-21, was written the evening before two
// writer fixes landed (an off-topic figure quoted as evidence; product facts
// asserted about a site nobody had read). The customer had not opened it, and
// nothing in the product could write it again: the account's one pre-trial
// draft was spent, so every door refused on the trial hold, and there is no
// "regenerate article" anywhere a customer or an operator can reach.
//
// This is that, for operators only. Same pipeline as any draft - research,
// writer, fact check, scoring - into the same row (`articleId`), so the
// customer's review queue, the calendar entry and the first-article card all
// keep pointing at it. The operator's email is passed as the caller, which is
// the quota's operator bypass (lib/billing/quota.ts): the rewrite adds no
// article, so the account is neither charged nor counted.
//
// Only an article nobody has acted on. Approved, scheduled, published or
// pushed to a CMS means a person has accepted that text or it is live, and
// replacing it underneath them is not an operator's call.
//
// The old body is not kept. An archived copy would be a second article in
// every quota count (only `error` is excluded), and `system_events` context
// is capped at 4 KB. What is recorded is enough to say what was replaced.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateArticle } from "@/lib/content/generate";
import { recordEvent } from "@/lib/observability/record";

export interface RegenerableRow {
  status: string;
  approved_at: string | null;
  published_url: string | null;
  published_at: string | null;
  external_id: string | null;
  scheduled_at: string | null;
}

/** Why this article may not be rewritten, or null when it may. Pure. */
export function notRegenerableReason(row: RegenerableRow): string | null {
  if (row.published_url || row.published_at || row.status === "live") return "it is published";
  if (row.external_id) return "it was pushed to the site's CMS";
  if (row.approved_at || row.status === "approved") return "it was approved";
  if (row.scheduled_at || row.status === "scheduled") return "it is scheduled";
  if (row.status === "drafting") return "it is being written right now";
  if (row.status !== "review" && row.status !== "draft") return `its status is ${row.status}`;
  return null;
}

export async function regenerateDraft(supabase: SupabaseClient, articleId: string, operatorEmail: string): Promise<void> {
  const { data: row, error } = await supabase
    .from("articles")
    .select(
      "id, workspace_id, keyword, keyword_id, title, word_count, fact_check_verdict, status, approved_at, published_url, published_at, external_id, scheduled_at, generated_autonomously, selection_reasons, selection_score, keyword_difficulty, volume",
    )
    .eq("id", articleId)
    .maybeSingle();
  if (error) throw new Error(`could not read the article: ${error.message}`);
  if (!row) throw new Error("no such article");
  const refused = notRegenerableReason(row as RegenerableRow);
  if (refused) throw new Error(`not regenerated: ${refused}`);

  const workspaceId = row.workspace_id as string;
  const { data: ws } = await supabase.from("workspaces").select("account_id").eq("id", workspaceId).maybeSingle();
  const accountId = (ws?.account_id as string | null) ?? null;
  const before = { title: row.title, wordCount: row.word_count, verdict: row.fact_check_verdict };

  await recordEvent(
    {
      level: "info",
      source: "admin.regenerate",
      message: `Regenerating "${row.title}" for ${operatorEmail}`,
      accountId,
      workspaceId,
      context: { articleId, operator: operatorEmail, before },
    },
    supabase,
  );

  const reasons = row.selection_reasons as string[] | null;
  const result = await generateArticle({
    supabase,
    workspaceId,
    articleId,
    keyword: row.keyword as string,
    ...(row.keyword_id ? { keywordId: row.keyword_id as string } : {}),
    autonomous: row.generated_autonomously === true,
    ...(reasons?.length
      ? {
          selection: {
            reasons,
            score: (row.selection_score as number | null) ?? 0,
            difficulty: (row.keyword_difficulty as number | null) ?? null,
            volume: (row.volume as number | null) ?? null,
          },
        }
      : {}),
    callerEmail: operatorEmail,
  });

  await recordEvent(
    {
      level: "info",
      source: "admin.regenerate",
      message: `Regenerated "${result.title}" (${result.wordCount} words, fact check ${result.factCheck.verdict})`,
      accountId,
      workspaceId,
      context: {
        articleId,
        operator: operatorEmail,
        before,
        after: { title: result.title, wordCount: result.wordCount, verdict: result.factCheck.verdict, seo: result.seoScore, aeo: result.aeoScore },
      },
    },
    supabase,
  );
}
