import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { canUpdate, type PublishMode, type PublishPayload, type PublishResult } from "@/lib/cms/types";
import { tiptapToHtml } from "@/lib/cms/html";
import { fetchLinkTargets, resolveInternalLinks } from "@/lib/seo/link-resolver";
import { submitForIndexing, type IndexingResult } from "@/lib/seo/indexing";
import { getValidAccessToken } from "@/lib/google/oauth";
import { decryptConfig } from "@/lib/crypto";
import type { CMSConfig } from "@/lib/types";
import { getQuota } from "@/lib/billing/quota";
import { appendAttribution, isOperatorAgency, shouldAttribute } from "@/lib/publishing/attribution";
import { chooseDestination, toDestinations, type IntegrationRow } from "@/lib/publishing/destinations";
import { settleExchangeForArticle } from "@/lib/seo/exchange";
import { createServiceClient } from "@/lib/supabase/server";
import { renderArticleMarkdown } from "@/lib/publishing/export";
import { recordPublish } from "@/lib/publishing/log";

/** Which connection an attempt went through, and how. Written to publish_log. */
export type PublishContext = {
  destinationId: string;
  publishMode: PublishMode;
};

/**
 * A publish that failed after its destination was resolved.
 *
 * The message is whatever the adapter or the database said - callers and
 * tests match on those - and the context is what the log needs to make the
 * failure retryable: a retry must go back through the same connection, and a
 * workspace with two CMSs cannot otherwise tell which one that was.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    public readonly context: PublishContext,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PublishError";
  }

  static wrap(err: unknown, context: PublishContext): PublishError {
    if (err instanceof PublishError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PublishError(message, context, { cause: err });
  }
}

/**
 * Publish a single article to its connected CMS.
 * Accepts a SupabaseClient so both server actions (user context)
 * and cron jobs (service role) can reuse the same logic.
 *
 * Does NOT call revalidatePath — callers handle cache invalidation.
 *
 * Resolves with the adapter's result plus the connection and mode it used, so
 * the caller can log them. Rejects with a PublishError carrying the same
 * context once a destination has been chosen; before that (article missing,
 * not approved, nothing connected) with a plain Error, since there is nothing
 * to retry through.
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
): Promise<PublishResult & PublishContext> {
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
  const context: PublishContext = {
    destinationId: destination.id,
    publishMode: destination.publishMode,
  };

  try {
    const result = await pushToDestination(supabase, article as ArticleRow, articleId, cmsIntegration, context);
    return { ...result, ...context };
  } catch (err) {
    throw PublishError.wrap(err, context);
  }
}

/** The columns of the articles row this module reads. Selected with `*`. */
type ArticleRow = {
  workspace_id: string;
  title: string;
  slug: string;
  content: unknown;
  meta_description: string | null;
  featured_image_url: string | null;
  external_id: string | null;
  published_url: string | null;
  keyword: string | null;
  created_at: string | null;
  published_at: string | null;
};

/** Everything after the destination is known; failures here are retryable. */
async function pushToDestination(
  supabase: SupabaseClient,
  article: ArticleRow,
  articleId: string,
  cmsIntegration: { config: unknown },
  context: PublishContext,
): Promise<PublishResult> {
  const { publishMode } = context;
  const config = decryptConfig(cmsIntegration.config as Record<string, unknown>) as CMSConfig;
  const adapter = resolveCMSAdapter(config, {
    /**
     * Adapters that retry over HTTP (webhook, WordPress plugin) report each
     * try. One publish_log row per attempt, marked `webhook` and carrying the
     * connection it went through, so the log shows an endpoint that failed
     * twice before accepting - the caller still writes its own success/error
     * row for the publish as a whole.
     */
    onDelivery: (attempt) => {
      const where = attempt.status ? ` HTTP ${attempt.status}` : "";
      return recordPublish(supabase, {
        articleId,
        workspaceId: article.workspace_id,
        status: attempt.ok ? "success" : "error",
        error: attempt.ok
          ? null
          : `delivery attempt ${attempt.attempt}/${attempt.maxAttempts}${where}: ${attempt.error ?? "no response"}`,
        triggeredBy: "webhook",
        destinationId: context.destinationId,
        publishMode: context.publishMode,
      });
    },
  });

  let html = tiptapToHtml(article.content as Record<string, unknown>);

  // Resolve any internal link placeholder still in the document. Generation
  // resolves or unwraps them, so this only matters for a draft written by hand
  // or before that was true; either way nothing may publish with a template
  // string, a `#` or a guessed path in an href.
  try {
    html = resolveInternalLinks(
      html,
      await fetchLinkTargets(supabase, article.workspace_id, articleId),
    );
  } catch {
    // Link resolution is non-blocking: publish with whatever we have.
  }

  /**
   * The free tier's articles carry a "Powered by AltoRank" line. Decided by
   * the quota's reason, so self-host, operators and every paid plan publish
   * clean - see lib/publishing/attribution.ts for why it sits here and not
   * behind a feature flag. Never blocks a publish: if we cannot tell what
   * plan someone is on, we do not brand their article.
   */
  let siteUrl = "https://example.com";
  try {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("agency_id, domain, agency:agencies(remove_branding)")
      .eq("id", article.workspace_id)
      .single();
    if (ws?.domain) siteUrl = `https://${String(ws.domain).replace(/^https?:\/\//, "")}`;
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

  const payload: PublishPayload = {
    id: articleId,
    title: article.title,
    html,
    // Only the webhook contract carries Markdown; rendering it for a CMS that
    // takes HTML would be work nobody reads.
    markdown:
      config.type === "webhook"
        ? renderArticleMarkdown(
            {
              title: article.title,
              slug: article.slug,
              html,
              metaDescription: article.meta_description,
              keyword: article.keyword,
              featuredImageUrl: article.featured_image_url,
              publishedAt: article.published_at,
            },
            siteUrl,
          )
        : undefined,
    slug: article.slug,
    metaDescription: article.meta_description ?? undefined,
    focusKeyword: article.keyword ?? undefined,
    createdAt: article.created_at ?? undefined,
    featuredImageUrl: article.featured_image_url ?? undefined,
    publishMode,
  };

  /**
   * Never a second copy. An article that already has an external id has a
   * post on this CMS - typically a retry after the first attempt got as far
   * as creating it, or a git publish whose URL never confirmed - and a fresh
   * create would leave two. Adapters that can edit in place do; git's publish
   * is already an upsert keyed on the file path. Anything else is refused,
   * because the person can resolve a duplicate-or-not question and this code
   * cannot.
   */
  const existingId: string | null = article.external_id ?? null;
  let result: PublishResult;
  if (existingId && canUpdate(adapter)) {
    result = await adapter.update(existingId, payload);
  } else if (existingId && config.type !== "git") {
    throw new Error(
      `This article already exists on ${config.type}${
        article.published_url ? ` (${article.published_url})` : ""
      } and that destination cannot be updated in place from here. Unpublish it first, or edit it on the CMS.`,
    );
  } else {
    result = await adapter.publish(payload);
  }

  // A draft on the CMS is not on the web. Marking it live here made the
  // dashboard count it as published, told agents not to regenerate it, and
  // shipped the keyword. It stays approved until the far side publishes it.
  const heldAsDraft = publishMode === "draft" || result.status === "draft";
  const { error: updateErr } = await supabase
    .from("articles")
    .update({
      status: heldAsDraft ? "approved" : "live",
      // Where it actually went, not where a form once said it might. A
      // republish or an unpublish reads this to reach the same system.
      cms: config.type,
      external_id: result.externalId,
      // A draft may have no public address yet (Wix returns none); null says
      // so, where "" would render as a link to nowhere.
      published_url: result.url || null,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", articleId);

  if (updateErr) throw new Error(updateErr.message);

  /**
   * A draft is not on the web. Whether the connection asked for one
   * (publish_mode) or the far side held it (the WordPress plugin's own "post
   * as draft" setting, reported as result.status), telling IndexNow or Search
   * Console about a URL the CMS is still holding back would submit a 404 under
   * the client's domain, and the exchange settles on a publish, which this is
   * not yet. The indexing status says where the article is waiting.
   */
  if (publishMode === "draft" || result.status === "draft") {
    await supabase
      .from("articles")
      .update({
        indexing_status: { indexnow: "held-in-cms", google: "held-in-cms" } satisfies IndexingResult,
      })
      .eq("id", articleId);
    return result;
  }

  /**
   * If this article was written for somebody else's exchange request, the
   * trade settles now, because it published - not because a link survived
   * (lib/seo/exchange.ts settlementDecision says why). Its own client, since
   * credits are written for two accounts and RLS scopes a member to their own.
   * Never worth failing a publish that already happened.
   */
  try {
    await settleExchangeForArticle(createServiceClient(), articleId);
  } catch (err) {
    console.warn("[publish] exchange settlement failed:", err);
  }

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
