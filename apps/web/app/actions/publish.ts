"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { decryptConfig } from "@/lib/crypto";
import { publishArticleCore } from "@/lib/publishing/core";
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
