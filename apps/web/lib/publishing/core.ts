import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { tiptapToHtml } from "@/lib/cms/html";
import { resolveInternalLinks } from "@/lib/seo/link-resolver";
import { decryptConfig } from "@/lib/crypto";
import type { CMSConfig } from "@/lib/types";

/**
 * Publish a single article to its connected CMS.
 * Accepts a SupabaseClient so both server actions (user context)
 * and cron jobs (service role) can reuse the same logic.
 *
 * Does NOT call revalidatePath — callers handle cache invalidation.
 */
export async function publishArticleCore(
  supabase: SupabaseClient,
  articleId: string,
) {
  const { data: article, error: articleErr } = await supabase
    .from("articles")
    .select("*")
    .eq("id", articleId)
    .single();

  if (articleErr || !article) throw new Error("Article not found");
  if (!article.content) throw new Error("Article has no content to publish");

  // Approval-first gate (the single enforced checkpoint): nothing reaches the CMS
  // unless it was explicitly approved, or scheduled WITH a recorded approval.
  // Both the manual publish action and the cron flow through here. Rows scheduled
  // before approval existed have approved_by = null and must not slip through.
  const isApproved = article.status === "approved";
  const isApprovedSchedule =
    article.status === "scheduled" && article.approved_by != null;
  if (!isApproved && !isApprovedSchedule) {
    throw new Error(
      `Article must be approved before publishing (current status: ${article.status}).`,
    );
  }

  const { data: wsIntegrations } = await supabase
    .from("workspace_integrations")
    .select("*, integration:integrations(*)")
    .eq("workspace_id", article.workspace_id);

  const cmsIntegration = wsIntegrations?.find(
    (wi: { integration?: { tag?: string } }) => wi.integration?.tag === "CMS",
  );

  if (!cmsIntegration)
    throw new Error("No CMS integration connected for this workspace");

  const config = decryptConfig(cmsIntegration.config as Record<string, unknown>) as CMSConfig;
  const adapter = resolveCMSAdapter(config);

  let html = tiptapToHtml(article.content as Record<string, unknown>);

  // Resolve any remaining internal link placeholders before publishing
  try {
    html = await resolveInternalLinks(
      supabase,
      html,
      article.workspace_id,
      articleId,
    );
  } catch {
    // Link resolution is non-blocking — publish with whatever we have
  }

  const result = await adapter.publish({
    title: article.title,
    html,
    slug: article.slug,
    metaDescription: article.meta_description ?? undefined,
    featuredImageUrl: article.featured_image_url ?? undefined,
  });

  const { error: updateErr } = await supabase
    .from("articles")
    .update({
      status: "live",
      cms: article.cms ?? config.type,
      external_id: result.externalId,
      published_url: result.url,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId);

  if (updateErr) throw new Error(updateErr.message);

  return result;
}
