import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import { tiptapToHtml } from "@/lib/cms/html";
import type { ArticleResearch } from "@/lib/seo/research";
import { createServiceClient } from "@/lib/supabase/server";
import { readWorkspaceLanguage } from "@/lib/i18n/workspace-language";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { readArticlesWhole } from "@/lib/articles/body-read";
import { announceDraftApproved } from "@/lib/email/approval-events";

/**
 * The approval, without a session.
 *
 * app/actions/publish.ts approves for a signed-in person: their client's RLS
 * decides which articles they may touch, then the checks below run and the
 * server writes the sign-off. The embedded Shopify app has no session - its
 * caller is a verified Shopify ID token resolved to one account and site - so
 * it calls `approveForWorkspace`, which asks the same questions with explicit
 * scoping instead of RLS. Both paths share the fact check and the write, so
 * the gate cannot drift between them.
 */

export interface FactCheckable {
  id: string;
  content: unknown;
  research: unknown;
  workspace_id: string;
}

/**
 * The one hard gate on approval: a bare, unattributed figure.
 *
 * Re-runs the fact check on the text as it is NOW, stores the fresh report so
 * the panel agrees with the refusal, and throws the blocker when there is
 * one. Named-but-unverified sources do not block: that is the reviewer's call.
 * `db` writes the report; it is scoped to the article's own site, so a service
 * client cannot reach another one.
 */
export async function refuseUnsourcedFiguresIn(db: SupabaseClient, article: FactCheckable): Promise<void> {
  if (!article.content) return;
  const language = await readWorkspaceLanguage(db, article.workspace_id, "approve");
  const html = tiptapToHtml(article.content as Record<string, unknown>);
  const report = factCheckArticle(html, (article.research as ArticleResearch | null) ?? undefined, language);

  await db
    .from("articles")
    .update({ fact_checks: report, fact_check_verdict: report.verdict })
    .eq("id", article.id)
    .eq("workspace_id", article.workspace_id);

  const blocker = approvalBlocker(report);
  if (blocker) throw new Error(blocker);
}

/**
 * The sign-off itself, written by the server (migration 109: no client token
 * may set `approved` or `approved_by`). Guarded on `status = 'review'`, so a
 * draft edited or approved under the caller does not move twice. Returns the
 * ids that moved.
 */
export async function writeApproval(ids: string[], approvedBy: string): Promise<string[]> {
  if (!ids.length) return [];
  const now = new Date().toISOString();
  const { data, error } = await createServiceClient()
    .from("articles")
    .update({
      status: "approved",
      approved_by: approvedBy,
      approved_at: now,
      approval_kind: "human",
      auto_approve_hold_reason: null,
      updated_at: now,
    })
    .in("id", ids)
    .eq("status", "review")
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id as string);
}

export interface ServerApprover {
  accountId: string;
  workspaceId: string;
  /** The auth user recorded as `approved_by` (an FK to auth.users). */
  userId: string;
  /** Who the approval email names. */
  actor: Pick<User, "email" | "user_metadata">;
}

/**
 * Approve one article on behalf of a caller the server has already
 * authenticated and scoped to `workspaceId`. Same checks as the signed-in
 * action, in the same order: a plan, the article in review on THIS site, an
 * open body, no unsourced figure.
 */
export async function approveForWorkspace(db: SupabaseClient, who: ServerApprover, articleId: string): Promise<void> {
  // `null` email: no session, so the quota reads no cookie.
  if (await needsPlanToShip(db, who.accountId, null)) throw new Error(CHOOSE_PLAN_MESSAGE);

  const { data: row } = await db
    .from("articles")
    .select("id")
    .eq("id", articleId)
    .eq("workspace_id", who.workspaceId)
    .eq("status", "review")
    .maybeSingle();
  if (!row) throw new Error("Article must be in review to approve");

  if ((await accountTrialGate(db, who.accountId, null)) === "gated") throw new Error(BODY_LOCKED_MESSAGE);
  // readArticlesWhole trusts its ids; the scoped read above is what vouches for this one.
  const [article] = await readArticlesWhole<FactCheckable>([articleId], "id, content, research, workspace_id");
  if (!article) throw new Error("Article must be in review to approve");
  await refuseUnsourcedFiguresIn(db, article);

  const moved = await writeApproval([articleId], who.userId);
  if (!moved.length) throw new Error("Article must be in review to approve");
  await announceDraftApproved(articleId, who.actor);
}
