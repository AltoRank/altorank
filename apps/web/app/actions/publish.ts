"use server";

import { revalidatePath } from "next/cache";
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import { tiptapToHtml } from "@/lib/cms/html";
import type { ArticleResearch } from "@/lib/seo/research";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { decryptConfig } from "@/lib/crypto";
import { publishArticleCore, PublishError, type PublishContext } from "@/lib/publishing/core";
import { chooseDestination, toDestinations, type IntegrationRow } from "@/lib/publishing/destinations";
import { recordPublish } from "@/lib/publishing/log";
import { retryPublishCore } from "@/lib/publishing/retry";
import type { PublishResult } from "@/lib/cms/types";
import { submitForIndexing } from "@/lib/seo/indexing";
import type { CMSConfig } from "@/lib/types";

/**
 * `destinationId` is the workspace_integrations row the person picked in the
 * editor when the workspace has more than one CMS connected. Omitted, the core
 * falls back to where the article already went, then to the first connection.
 */
export async function publishArticle(articleId: string, destinationId?: string | null) {
  const { user, agencyId } = await requireAuth();
  const supabase = await createClient();
  if (await needsPlanToShip(supabase, agencyId, user.email)) throw new Error(CHOOSE_PLAN_MESSAGE);

  // Fetch workspace_id up front so we can log to publish_log on BOTH the success
  // and the error path — closing the manual-publish audit gap fully (the cron
  // logs successes and failures; the manual path previously logged only success).
  const { data: art } = await supabase
    .from("articles")
    .select("workspace_id")
    .eq("id", articleId)
    .single();

  return runAndLog(supabase, articleId, art?.workspace_id ?? null, () =>
    publishArticleCore(supabase, articleId, { destinationId }),
  );
}

/**
 * Run one publish attempt and write its publish_log row either way.
 *
 * The row carries which connection the attempt used and in which mode - on
 * success from the result, on failure from the PublishError the core throws
 * once a destination is known. A failure before that (not approved, nothing
 * connected) is logged with neither, and is not something a retry can fix.
 */
async function runAndLog(
  supabase: Awaited<ReturnType<typeof createClient>>,
  articleId: string,
  workspaceId: string | null,
  attempt: () => Promise<PublishResult & PublishContext>,
) {
  try {
    const result = await attempt();
    if (workspaceId) {
      await recordPublish(supabase, {
        articleId,
        workspaceId,
        status: "success",
        triggeredBy: "manual",
        destinationId: result.destinationId,
        publishMode: result.publishMode,
      });
    }
    revalidatePath("/articles");
    revalidatePath(`/content/${articleId}`);
    return result;
  } catch (err) {
    if (workspaceId) {
      const context = err instanceof PublishError ? err.context : null;
      await recordPublish(supabase, {
        articleId,
        workspaceId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        triggeredBy: "manual",
        destinationId: context?.destinationId,
        publishMode: context?.publishMode,
      });
    }
    throw err;
  }
}

/**
 * Approve an article for publishing (review → approved). The publish gate in
 * publishArticleCore refuses anything not approved, so this is the editorial
 * checkpoint. Records who approved + when (the sign-off).
 */
export async function approveArticle(articleId: string) {
  const { user, agencyId } = await requireAuth();
  const supabase = await createClient();
  // The free draft can be read, edited and rewritten; it cannot ship without
  // a plan. This is the one paywall in the product and it sits exactly where
  // the value is, not at signup.
  if (await needsPlanToShip(supabase, agencyId, user.email)) throw new Error(CHOOSE_PLAN_MESSAGE);

  await refuseUnsourcedFigures(supabase, articleId);

  const { data, error } = await supabase
    .from("articles")
    .update({
      status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "review")
    .select("id")
    .single();

  if (error || !data) throw new Error("Article must be in review to approve");

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

/**
 * The one hard gate on approval: a bare, unattributed figure.
 *
 * Re-runs the fact check on what is in the editor NOW, not on the report
 * stored at generation, so a reviewer who has just sourced or cut the numbers
 * is not refused on stale evidence; and stores the fresh report, so the panel
 * agrees with the refusal. Named-but-unverified sources do not block: that is
 * the reviewer's judgement, which is what the review step is for.
 */
async function refuseUnsourcedFigures(
  supabase: Awaited<ReturnType<typeof createClient>>,
  articleId: string,
) {
  const { data: article } = await supabase
    .from("articles")
    .select("content, research")
    .eq("id", articleId)
    .single();
  if (!article?.content) return;

  const html = tiptapToHtml(article.content as Record<string, unknown>);
  const report = factCheckArticle(html, (article.research as ArticleResearch | null) ?? undefined);

  await supabase
    .from("articles")
    .update({ fact_checks: report, fact_check_verdict: report.verdict })
    .eq("id", articleId);

  const blocker = approvalBlocker(report);
  if (blocker) throw new Error(blocker);
}

/**
 * Approve several review-state articles at once. Same transition, same
 * sign-off record per article; the only thing batched is the click.
 *
 * Reviewers of the autopilot tools asked for exactly this ("batch review of
 * drafts") and the tools could not offer it because their drafts were already
 * live. Ours are not. Returns the ids that actually moved, so the caller can
 * say "3 of 4 approved" when one was edited under it.
 */
export async function approveArticles(articleIds: string[]): Promise<string[]> {
  const { user, agencyId } = await requireAuth();
  const supabase = await createClient();
  if (await needsPlanToShip(supabase, agencyId, user.email)) throw new Error(CHOOSE_PLAN_MESSAGE);
  const requested = [...new Set(articleIds)].filter(Boolean);
  if (!requested.length) return [];

  // Same gate as the single approve, per article. A refused draft simply does
  // not move, and the caller's "3 of 4 approved" already covers that outcome.
  const ids: string[] = [];
  for (const id of requested) {
    try {
      await refuseUnsourcedFigures(supabase, id);
      ids.push(id);
    } catch {
      // refused: left in review
    }
  }
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("articles")
    .update({
      status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "review")
    .select("id");

  if (error) throw new Error(error.message);
  revalidatePath("/articles");
  for (const row of data ?? []) revalidatePath(`/content/${row.id}`);
  return (data ?? []).map((r) => r.id as string);
}

/**
 * Send an approved article back for changes (approved → review), clearing the
 * sign-off so it must be re-approved before it can publish.
 */
export async function requestChanges(articleId: string) {
  await requireAuth();
  const supabase = await createClient();

  const { error } = await supabase
    .from("articles")
    .update({
      status: "review",
      approved_by: null,
      approved_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "approved");

  if (error) throw new Error(error.message);

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

export async function unpublishArticle(articleId: string) {
  await requireAuth();
  const supabase = await createClient();

  const { data: article } = await supabase
    .from("articles")
    .select("*, workspace_id")
    .eq("id", articleId)
    .single();

  if (!article?.external_id) throw new Error("Article has no external ID");

  const { data: wsIntegrations } = await supabase
    .from("workspace_integrations")
    .select("*, integration:integrations(*)")
    .eq("workspace_id", article.workspace_id);

  // The system the article was published to, not the first one in the list:
  // with two CMSs connected the old `find(tag === "CMS")` could ask the wrong
  // one to delete a post it never held.
  const destination = chooseDestination(toDestinations((wsIntegrations ?? []) as IntegrationRow[]), article);
  const cmsIntegration = (wsIntegrations ?? []).find((wi) => wi.id === destination.id)!;

  const config = decryptConfig(cmsIntegration.config as Record<string, unknown>) as CMSConfig;
  const adapter = resolveCMSAdapter(config);

  await adapter.unpublish(article.external_id);

  await supabase
    .from("articles")
    .update({
      status: "review",
      external_id: null,
      published_url: null,
      published_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId);

  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
}

/**
 * Retry the last failed publish of an article.
 *
 * Same article, same connection the failed attempt used, one more publish_log
 * row pointing back at the failed one. Refuses when there is nothing failed to
 * retry - a second Publish button is what the old version amounted to - and
 * never creates a second post: the core edits in place when the article
 * already has an external id (lib/publishing/core.ts says how).
 */
export async function retryPublish(articleId: string) {
  const { user, agencyId } = await requireAuth();
  const supabase = await createClient();
  if (await needsPlanToShip(supabase, agencyId, user.email)) throw new Error(CHOOSE_PLAN_MESSAGE);

  const result = await retryPublishCore(supabase, articleId, "manual");
  revalidatePath("/articles");
  revalidatePath(`/content/${articleId}`);
  return result;
}

/**
 * Record that an approved article was published by hand.
 *
 * Most sites this product analyses have no CMS to post to. A Next.js, Astro or
 * Hugo site builds from a repository, and the honest answer for someone who
 * does not want to hand over a repo token is "here is the file, commit it
 * yourself". Before this there was nowhere for that to land: the article sat in
 * `approved` for ever, reading as unfinished work, and the whole flow appeared
 * broken for exactly the sites the readiness checker is best at.
 *
 * This does not publish anything. It records that a human did, which is a
 * different and much smaller claim - hence the required URL: without one there
 * is no evidence the article is anywhere, and marking it live would be the same
 * class of fiction as a fabricated metric.
 */
export async function markPublishedManually(articleId: string, publishedUrl: string) {
  const { user } = await requireAuth();
  const supabase = await createClient();

  const url = publishedUrl.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url)) {
    throw new Error("Enter the full URL the article now lives at, including https://");
  }

  const { data: article } = await supabase
    .from("articles")
    .select("workspace_id, status")
    .eq("id", articleId)
    .single();

  if (!article) throw new Error("Article not found");
  if (article.status !== "approved") {
    throw new Error(
      `Only an approved article can be marked published (current status: ${article.status}).`,
    );
  }

  const { error } = await supabase
    .from("articles")
    .update({
      status: "live",
      published_url: url,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId)
    .eq("status", "approved");

  if (error) throw new Error(error.message);

  /**
   * Tell the engines, same as an automated publish would. This path skipped
   * indexing entirely, which is backwards: the manually published sites are
   * exactly the ones with no CMS pinging anything on their behalf. GSC
   * sitemap resubmission is omitted here on purpose - a hand-published page
   * may not be in the sitemap yet, and IndexNow takes the URL directly.
   */
  try {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("indexnow_key")
      .eq("id", article.workspace_id)
      .single();
    const indexing = await submitForIndexing({
      url,
      indexNowKey: ws?.indexnow_key ?? null,
      gscToken: null,
    });
    await supabase.from("articles").update({ indexing_status: indexing }).eq("id", articleId);
  } catch (err) {
    console.warn("[publish] manual-publish indexing failed:", err);
  }

  // Same audit trail as an automated publish, so the log does not quietly omit
  // the ones a person did.
  const { error: logErr } = await supabase.from("publish_log").insert({
    article_id: articleId,
    workspace_id: article.workspace_id,
    status: "success",
    triggered_by: "manual",
  });
  if (logErr) console.error("publish_log insert failed:", logErr.message);

  revalidatePath(`/content/${articleId}`);
  revalidatePath("/articles");
}
