import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { canUpdate, type PublishMode, type PublishPayload, type PublishResult } from "@/lib/cms/types";
import { submitForIndexing, type IndexingResult } from "@/lib/seo/indexing";
import { getValidAccessToken } from "@/lib/google/oauth";
import { decryptConfig } from "@/lib/crypto";
import type { Article, CMSConfig } from "@/lib/types";
import { workspaceTrialGate } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { chooseDestination, toDestinations, type IntegrationRow } from "@/lib/publishing/destinations";
import { settleExchangeForArticle } from "@/lib/seo/exchange";
import { createServiceClient } from "@/lib/supabase/server";
import { readVisibleArticle } from "@/lib/articles/body-read";
import { renderArticleMarkdown } from "@/lib/publishing/export";
import { renderPublishedBody } from "@/lib/publishing/render";
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
  // Visibility through the caller's client - RLS for the person pressing
  // Publish, everything for the cron - and the row itself from the server,
  // because the body columns answer no client token (migration 097,
  // lib/articles/body-read.ts).
  const article = await readVisibleArticle<Article>(supabase, articleId);

  if (!article) throw new Error("Article not found");
  if (!article.content) throw new Error("Article has no content to publish");

  // Approval-first gate (the single enforced checkpoint): nothing reaches the CMS
  // unless it is approved or scheduled AND carries a recorded approval. Both
  // the manual publish action and the cron flow through here. `approved` used
  // to pass on its status alone, so a row that reached `approved` without
  // the approve action (a status written straight to the table) published
  // under nobody's name; the status is a state, the approval is the person.
  publishGate(article);

  // The trial gate, here and not only at Approve. Approving asks for a plan
  // (app/actions/publish.ts), but `status` is also written through the
  // person's own client - the editor saves that way - so an account that had
  // not started its trial could set its first draft to `approved` over
  // PostgREST, and cron/publish would push the text to the CMS it connected
  // during setup. Publishing is handing the text out; the gate decides that.
  if ((await workspaceTrialGate(supabase, article.workspace_id)) === "gated") {
    throw new Error(BODY_LOCKED_MESSAGE);
  }

  return deliverArticle(supabase, article as DeliverableArticle, articleId, opts);
}

/**
 * Choose the destination and send an article row that has already passed its
 * gates: the renderer (title H1 strip, link resolution, attribution, structured
 * data, dateline, webhook Markdown, the connection's publish mode) and the
 * bookkeeping after it.
 *
 * `publishArticleCore` calls it after the approval and trial gates. The
 * Improvements push (lib/refresh/push.ts) calls it with the reviewed body in
 * `article.content`, after its own gates, so an updated post goes out exactly
 * as a published one does. `inPlaceOnly` refuses a destination that cannot
 * edit the existing post, where a publish would create a second copy.
 * `publishMode` overrides the connection's mode: the push passes `publish`
 * for a post that is already live, because a draft-mode connection's "draft"
 * would take the live page off the site rather than stage the edit.
 */
export async function deliverArticle(
  supabase: SupabaseClient,
  article: DeliverableArticle,
  articleId: string,
  opts: { destinationId?: string | null; inPlaceOnly?: boolean; publishMode?: PublishMode } = {},
): Promise<PublishResult & PublishContext> {
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
    publishMode: opts.publishMode ?? destination.publishMode,
  };

  if (opts.inPlaceOnly) {
    const config = decryptConfig(cmsIntegration.config as Record<string, unknown>) as CMSConfig;
    if (!article.external_id || !canUpdate(resolveCMSAdapter(config))) {
      throw new Error(
        `The ${destination.label} connection can publish new posts but cannot yet edit an existing one, and publishing a second copy of this page would be worse than not pushing. Copy the HTML and update the post in ${destination.label}.`,
      );
    }
  }

  try {
    const result = await pushToDestination(supabase, article, articleId, cmsIntegration, context);
    return { ...result, ...context };
  } catch (err) {
    throw PublishError.wrap(err, context);
  }
}

/**
 * Whether an article may be pushed: approved or scheduled, with the approval
 * recorded. Exported for the retry path and the tests; the refusal names the
 * missing piece so the person knows to approve it, not to "fix" a status.
 */
export function publishGate(article: { status: string; approved_by?: string | null }): void {
  if (article.status !== "approved" && article.status !== "scheduled") {
    throw new Error(
      `Article must be approved before publishing (current status: ${article.status}).`,
    );
  }
  if (!article.approved_by) {
    throw new Error(
      `Article must be approved before publishing: it is ${article.status} but nobody's approval is recorded. Send it back to review and approve it.`,
    );
  }
}

/** The columns of the articles row this module reads. Selected with `*`. */
export type DeliverableArticle = {
  workspace_id: string;
  /** Where it went last, so a republish goes back through the same connection. */
  cms?: string | null;
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
  /** `held-in-cms` when the last push was kept as a draft on the far side. */
  indexing_status?: { indexnow?: unknown } | null;
  /** Set when the article was found live on the site after a held push. */
  found_on_site_at?: string | null;
};

/** Everything after the destination is known; failures here are retryable. */
async function pushToDestination(
  supabase: SupabaseClient,
  article: DeliverableArticle,
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

  // When it first went live, kept across republishes, and now. A republish
  // is an update: the page's "published" date (the dateline, BlogPosting,
  // git's publishDate, Shopify's published_at) is the day it first went out,
  // where it used to be overwritten on every push. A push the CMS held as a
  // draft is not a publish, so its date is not kept: the push that takes the
  // article live is the first publish - unless the article was since found
  // live on the site, whose date that check recorded.
  const lastPushHeld = article.indexing_status?.indexnow === "held-in-cms" && !article.found_on_site_at;
  const publishedAt = (!lastPushHeld && article.published_at) || new Date().toISOString();
  const modifiedAt = new Date().toISOString();

  // Title heading, links, attribution, structured data, dateline: the same
  // steps the blog API runs (lib/publishing/render.ts).
  const { html, structuredData, siteUrl, indexNowKey } = await renderPublishedBody(supabase, article, articleId, {
    publishedAt,
    modifiedAt,
    jsonLdInBodyFor: config.type,
  });

  const payload: PublishPayload = {
    id: articleId,
    indexNowKey,
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
              publishedAt,
            },
            siteUrl,
          )
        : undefined,
    slug: article.slug,
    metaDescription: article.meta_description ?? undefined,
    focusKeyword: article.keyword ?? undefined,
    createdAt: article.created_at ?? undefined,
    publishedAt,
    modifiedAt,
    featuredImageUrl: article.featured_image_url ?? undefined,
    publishMode,
    structuredData,
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
    // "Unpublish it first" was an instruction the product cannot obey:
    // unpublishArticle exists in app/actions/publish.ts and has no caller
    // anywhere in the UI. Say what can actually be done instead. Most
    // destinations can now be edited in place - only Notion and Wix reach
    // this branch - so it is rare as well as honest.
    throw new Error(
      `This article already exists on ${config.type}${
        article.published_url ? ` (${article.published_url})` : ""
      }, and ${config.type} pages cannot be replaced from here. Edit it on ${config.type}, or delete it there and publish again.`,
    );
  } else {
    result = await adapter.publish(payload);
  }

  // A draft on the CMS is not on the web. Marking it live here made the
  // dashboard count it as published, told agents not to regenerate it, and
  // shipped the keyword. It stays approved until the far side publishes it.
  const heldAsDraft = publishMode === "draft" || result.status === "draft";
  // Written by the server, whoever pressed Publish: `live` (and `approved`)
  // are not statuses a signed-in user's client may set (migration 109). The
  // caller's client has already shown, by reading the row, that they may act
  // on this article.
  const { error: updateErr } = await createServiceClient()
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
      // The first publish, kept: a republish is an update, and the page's
      // "published" date (the dateline, BlogPosting, git's publishDate) is
      // the day it first went out. Was overwritten on every push.
      published_at: publishedAt,
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

    // A local or preview run must not tell IndexNow or Search Console about a
    // customer's URL: a re-test did exactly that once. Production, or an
    // explicit opt-in, is the only place these submissions leave the box.
    if (process.env.NODE_ENV !== "production" && process.env.ALLOW_INDEXING_SUBMISSIONS !== "1") {
      console.warn("[publish] indexing submission skipped outside production");
      return result;
    }
    /**
     * Nothing to submit without an address. An adapter returns "" when the
     * destination reports no URL and the connection stores no public prefix
     * to build one from (Webflow, Wix, Framer, a git connection with no
     * public URL); published_url is null in that case, and submitting an
     * empty string would have been a request about the customer's domain
     * root.
     */
    if (!result.url) {
      console.warn("[publish] no published URL to submit for indexing");
      return result;
    }

    const indexing = await submitForIndexing({
      url: result.url,
      indexNowKey,
      gscToken,
      keyLocation: result.indexNowKeyLocation ?? null,
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
