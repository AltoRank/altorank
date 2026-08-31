"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { decryptConfig } from "@/lib/crypto";
import { publishArticleCore } from "@/lib/publishing/core";
import { submitForIndexing } from "@/lib/seo/indexing";
import type { CMSConfig } from "@/lib/types";

export async function publishArticle(articleId: string) {
  await requireAuth();
  const supabase = await createClient();

  // Fetch workspace_id up front so we can log to publish_log on BOTH the success
  // and the error path — closing the manual-publish audit gap fully (the cron
  // logs successes and failures; the manual path previously logged only success).
  const { data: art } = await supabase
    .from("articles")
    .select("workspace_id")
    .eq("id", articleId)
    .single();

  async function logPublish(status: "success" | "error", error?: string) {
    if (!art) return;
    const { error: logErr } = await supabase.from("publish_log").insert({
      article_id: articleId,
      workspace_id: art.workspace_id,
      status,
      triggered_by: "manual",
      ...(error ? { error } : {}),
    });
    // Don't fail the publish on a logging error, but don't swallow it silently.
    if (logErr) console.error("publish_log insert failed:", logErr.message);
  }

  try {
    const result = await publishArticleCore(supabase, articleId);
    await logPublish("success");
    revalidatePath("/articles");
    revalidatePath(`/content/${articleId}`);
    return result;
  } catch (err) {
    await logPublish("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Approve an article for publishing (review → approved). The publish gate in
 * publishArticleCore refuses anything not approved, so this is the editorial
 * checkpoint. Records who approved + when (the sign-off).
 */
export async function approveArticle(articleId: string) {
  const { user } = await requireAuth();
  const supabase = await createClient();

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

  const cmsIntegration = wsIntegrations?.find(
    (wi) => wi.integration?.tag === "CMS"
  );

  if (!cmsIntegration) throw new Error("No CMS integration found");

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

export async function retryPublish(articleId: string) {
  await requireAuth();
  // Reset and try again. Re-publishing implies the article was already approved
  // (it had to clear the gate to reach 'error'), so reset to 'approved' — a reset
  // to 'review' would now be rejected by the approval gate in publishArticleCore.
  const supabase = await createClient();
  await supabase
    .from("articles")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", articleId);

  return publishArticle(articleId);
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
