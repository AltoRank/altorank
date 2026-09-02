import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { tiptapToHtml } from "@/lib/cms/html";
import { resolveInternalLinks } from "@/lib/seo/link-resolver";
import { submitForIndexing, type IndexingResult } from "@/lib/seo/indexing";
import { getValidAccessToken } from "@/lib/google/oauth";
import { decryptConfig } from "@/lib/crypto";
import type { CMSConfig } from "@/lib/types";
import { getQuota } from "@/lib/billing/quota";
import { appendAttribution, isOperatorAgency, shouldAttribute } from "@/lib/publishing/attribution";
import { chooseDestination, toDestinations, type IntegrationRow } from "@/lib/publishing/destinations";

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
  /**
   * The workspace_integrations row to publish through, when the person chose
   * one. Omitted by the cron and by the single-connection case, where
   * `chooseDestination` falls back to where the article already went, then to
   * the first connection.
   */
  opts: { destinationId?: string | null } = {},
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

  // Same list the editor offers, same choice rule, so the button and the
  // action cannot disagree about where this goes.
  const destination = chooseDestination(
    toDestinations((wsIntegrations ?? []) as IntegrationRow[]),
    article,
    opts.destinationId,
  );
  const cmsIntegration = (wsIntegrations ?? []).find((wi) => wi.id === destination.id)!;

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

  /**
   * The free tier's articles carry a "Powered by AltoRank" line. Decided by
   * the quota's reason, so self-host, operators and every paid plan publish
   * clean - see lib/publishing/attribution.ts for why it sits here and not
   * behind a feature flag. Never blocks a publish: if we cannot tell what
   * plan someone is on, we do not brand their article.
   */
  try {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("agency_id, agency:agencies(remove_branding)")
      .eq("id", article.workspace_id)
      .single();
    if (ws?.agency_id) {
      const quota = await getQuota(supabase, ws.agency_id);
      const removeBranding =
        (ws.agency as { remove_branding?: boolean } | null)?.remove_branding ?? false;
      if (
        shouldAttribute(quota, removeBranding) &&
        // Crons carry no caller, so the operator check has to ask the agency.
        !(await isOperatorAgency(supabase, ws.agency_id))
      ) {
        html = appendAttribution(html);
      }
    }
  } catch {
    // Branding is never worth failing a publish over.
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
      // Where it actually went, not where a form once said it might. A
      // republish or an unpublish reads this to reach the same system.
      cms: config.type,
      external_id: result.externalId,
      published_url: result.url,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId);

  if (updateErr) throw new Error(updateErr.message);

  /**
   * Tell the engines. Publishing used to end here, leaving discovery to
   * whenever a crawler wandered past - days to weeks on a young domain, which
   * is the whole gap between "we published" and "anyone can find it".
   * Best-effort: a failed submission is logged on the article, never thrown,
   * because the publish it would fail has already happened.
   */
  try {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("indexnow_key")
      .eq("id", article.workspace_id)
      .single();

    // A live Search Console token, when the Google integration is connected.
    let gscToken: string | null = null;
    const { data: googleIntegrations } = await supabase
      .from("workspace_integrations")
      .select("id, tokens, integration:integrations(name)")
      .eq("workspace_id", article.workspace_id);
    const gsc = (googleIntegrations ?? []).find((wi) => {
      const name = (wi.integration as { name?: string } | null)?.name ?? "";
      return /search console/i.test(name);
    });
    const encrypted = (gsc?.tokens as { encrypted?: string } | null)?.encrypted;
    if (gsc && encrypted) {
      gscToken = await getValidAccessToken(encrypted, async (next) => {
        await supabase
          .from("workspace_integrations")
          .update({ tokens: { encrypted: next } })
          .eq("id", gsc.id);
      });
    }

    /**
     * A git publish is a commit, not a deploy. The host still has to build,
     * which takes tens of seconds to minutes, so the URL is guaranteed not to
     * resolve yet and telling IndexNow about it now would submit a 404.
     * app/api/cron/publish confirms it afterwards and submits then.
     */
    if (config.type === "git") {
      await supabase
        .from("articles")
        .update({
          indexing_status: {
            indexnow: "awaiting-build",
            google: "awaiting-build",
            urlVerified: "pending",
            attempts: 0,
          } satisfies IndexingResult,
        })
        .eq("id", articleId);
      return result;
    }

    const indexing = await submitForIndexing({
      url: result.url,
      indexNowKey: ws?.indexnow_key ?? null,
      gscToken,
    });
    await supabase
      .from("articles")
      .update({ indexing_status: indexing })
      .eq("id", articleId);
  } catch (err) {
    console.warn("[publish] indexing submission failed:", err);
  }

  return result;
}
