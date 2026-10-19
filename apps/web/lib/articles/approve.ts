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
import { getDestinations } from "@/lib/publishing/destinations";
import { recordArticlesApproved } from "@/lib/onboarding/step-events";

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
 * Sites where an approval takes the next publishing slot: an enabled cadence
 * and somewhere to publish. Both, because cron/publish phase 2 ships a queued
 * article to the site's CMS at the cadence slot; with no destination it would
 * only turn the approval into a failed publish. The destination test is the
 * one the auto-approve rule asks (getDestinations), so the two agree.
 */
export async function sitesThatTakeTheSlot(db: SupabaseClient, workspaceIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(workspaceIds)];
  if (!ids.length) return out;
  const { data, error } = await db
    .from("publishing_cadences")
    .select("workspace_id")
    .in("workspace_id", ids)
    .eq("enabled", true);
  if (error) throw new Error(`Could not read the publishing schedule: ${error.message}`);
  for (const row of (data ?? []) as Array<{ workspace_id: string }>) {
    if ((await getDestinations(db, row.workspace_id)).length > 0) out.add(row.workspace_id);
  }
  return out;
}

/** What an approval writes. With a slot, the row auto-approve and addToQueue write. */
export function approvalPatch(approvedBy: string, now: string, takesSlot: boolean) {
  return {
    ...(takesSlot ? { status: "scheduled" as const, scheduled_at: null } : { status: "approved" as const }),
    approved_by: approvedBy,
    approved_at: now,
    approval_kind: "human",
    auto_approve_hold_reason: null,
    updated_at: now,
  };
}

export interface ApprovalWritten {
  id: string;
  /** `scheduled` when the site has a publishing schedule: it ships at the next free slot. */
  status: "approved" | "scheduled";
}

/**
 * The sign-off itself, written by the server (migration 109: no client token
 * may set `approved` or `approved_by`). Guarded on `status = 'review'`, so a
 * draft edited or approved under the caller does not move twice. Returns the
 * rows that moved.
 *
 * On a site with a publishing schedule the approval also takes the next slot:
 * `scheduled` with no `scheduled_at`, which cron/publish phase 2 ships in
 * queue order. That is what auto-approve writes, so a person's approval and
 * the rule's end in the same place, and approving no longer needs a second
 * click (Add to queue) to mean "ship it". Without a schedule it stays
 * `approved`, for Publish now.
 */
export async function writeApproval(ids: string[], approvedBy: string): Promise<ApprovalWritten[]> {
  if (!ids.length) return [];
  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data: rows, error: readError } = await db.from("articles").select("id, workspace_id").in("id", ids).eq("status", "review");
  if (readError) throw new Error(readError.message);
  const inReview = (rows ?? []) as Array<{ id: string; workspace_id: string }>;
  if (!inReview.length) return [];
  const slotted = await sitesThatTakeTheSlot(db, inReview.map((r) => r.workspace_id));

  const out: ApprovalWritten[] = [];
  for (const takesSlot of [true, false]) {
    const group = inReview.filter((r) => slotted.has(r.workspace_id) === takesSlot).map((r) => r.id);
    if (!group.length) continue;
    const { data, error } = await db
      .from("articles")
      .update(approvalPatch(approvedBy, now, takesSlot))
      .in("id", group)
      .eq("status", "review")
      .select("id");
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push({ id: r.id as string, status: takesSlot ? "scheduled" : "approved" });
  }
  // The funnel's last step (onboarding.step). Every human approval comes
  // through here, the app's and the Shopify app's. Never throws.
  const siteOf = new Map(inReview.map((r) => [r.id, r.workspace_id]));
  await recordArticlesApproved(
    db,
    out.flatMap((a) => (siteOf.has(a.id) ? [{ id: a.id, workspaceId: siteOf.get(a.id)!, status: a.status }] : [])),
    approvedBy,
  );
  return out;
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
