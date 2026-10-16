import type { SupabaseClient } from "@supabase/supabase-js";
import type { CMSConfig } from "@/lib/types";
import { tiptapToHtml } from "@/lib/cms/html";
import { fetchLinkTargets, resolveInternalLinks } from "@/lib/seo/link-resolver";
import { getQuota } from "@/lib/billing/quota";
import { appendAttribution, isOperatorAccount, shouldAttribute } from "@/lib/publishing/attribution";
import { DEFAULT_OUTPUT_SETTINGS } from "@/lib/onboarding/output-settings";
import { removeTitleHeading } from "@/lib/content/on-page";
import { datelineHtml } from "@/lib/content/trust";

// ---------------------------------------------------------------------------
// The article body as it goes out
// ---------------------------------------------------------------------------
//
// Every step between the stored document and the HTML a site shows: the title
// heading removed, internal links resolved, the free tier's attribution, the
// structured data, and the dateline. publishArticleCore sends the result to a
// CMS; the blog API (/api/blog/v1) serves it to a site reading articles
// itself. One function, so a site on the blog API gets the same body as a site
// on a CMS - it used to get the bare document rendered to HTML.

export type RenderableArticle = {
  workspace_id: string;
  title: string;
  content: unknown;
  meta_description: string | null;
  featured_image_url: string | null;
  keyword: string | null;
};

export type RenderedBody = {
  html: string;
  /** BlogPosting (always) and FAQPage (per the site's setting), as JSON-LD objects. */
  structuredData: object[];
  siteUrl: string;
  publisherName: string;
  language: string | null;
  indexNowKey: string | null;
};

export async function renderPublishedBody(
  supabase: SupabaseClient,
  article: RenderableArticle,
  articleId: string,
  opts: {
    publishedAt: string;
    modifiedAt: string;
    /**
     * The destination type, when the JSON-LD should go inside the body as a
     * script (lib/publishing/schema.ts's SCRIPT_CAPABLE). Null keeps it out:
     * the blog API returns it as its own field for the site to emit.
     */
    jsonLdInBodyFor: CMSConfig["type"] | null;
  },
): Promise<RenderedBody> {
  // The title goes as its own field and every destination shows it as the
  // page's H1, so a body <h1> repeating it is a second H1 - which drafts
  // written before 2026-09-28 carry (lib/content/on-page.ts).
  let html = removeTitleHeading(tiptapToHtml(article.content as Record<string, unknown>), article.title).html;

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
  let publisherName = "";
  let language: string | null = null;
  // Read here with the rest of the workspace row: the payload carries it to
  // adapters that can host the key file, and the submission after the publish
  // uses the same value. Null when the workspace has none.
  let indexNowKey: string | null = null;
  // Whether the workspace row was read: a dateline is only written in a
  // language known to be the site's, never in a default guessed after a failure.
  let workspaceRead = false;
  try {
    const { data: ws } = await supabase
      .from("workspaces")
      .select("account_id, domain, language, business_profile, indexnow_key, account:accounts(remove_branding)")
      .eq("id", article.workspace_id)
      .single();
    indexNowKey = typeof ws?.indexnow_key === "string" ? ws.indexnow_key : null;
    if (ws?.domain) siteUrl = `https://${String(ws.domain).replace(/^https?:\/\//, "")}`;
    const profileName = (ws?.business_profile as { name?: unknown } | null)?.name;
    publisherName = (typeof profileName === "string" && profileName.trim()) || String(ws?.domain ?? "").replace(/^https?:\/\//, "");
    language = typeof ws?.language === "string" ? ws.language : null;
    workspaceRead = Boolean(ws);
    if (ws?.account_id) {
      const quota = await getQuota(supabase, ws.account_id);
      const removeBranding =
        (ws.account as { remove_branding?: boolean } | null)?.remove_branding ?? false;
      if (
        shouldAttribute(quota, removeBranding) &&
        // Crons carry no caller, so the operator check has to ask the account.
        !(await isOperatorAccount(supabase, ws.account_id))
      ) {
        html = appendAttribution(html, language);
      }
    }
  } catch {
    // Branding is never worth failing a publish over.
  }

  // Structured data, rebuilt from the body that is about to go out (see
  // lib/publishing/schema.ts). The FAQ follows the Article settings switch,
  // the BlogPosting always goes. Best effort, like the branding: a missing
  // settings row means the defaults, a failure means a page without schema
  // rather than no page.
  let structuredData: object[] = [];
  try {
    // Lazy for the same reason generate.ts loads the enrichment lazily: the
    // schema module reaches the FAQ extractor and the audit's generator, and
    // the mutation routes that import this file are tested under a budget.
    const { appendJsonLd, SCRIPT_CAPABLE, structuredDataFor } = await import("@/lib/publishing/schema");
    const { data: settings } = await supabase
      .from("workspace_output_settings")
      .select("faq_schema")
      .eq("workspace_id", article.workspace_id)
      .maybeSingle();
    const faqEnabled =
      typeof settings?.faq_schema === "boolean" ? settings.faq_schema : DEFAULT_OUTPUT_SETTINGS.faqSchema;
    structuredData = structuredDataFor(
      html,
      {
        title: article.title,
        description: article.meta_description,
        imageUrl: article.featured_image_url,
        datePublished: opts.publishedAt,
        dateModified: opts.modifiedAt,
        keyword: article.keyword,
        publisherName: publisherName || siteUrl.replace(/^https?:\/\//, ""),
        language,
      },
      faqEnabled,
    );
    if (opts.jsonLdInBodyFor && SCRIPT_CAPABLE.has(opts.jsonLdInBodyFor)) html = appendJsonLd(html, structuredData);
  } catch {
    // Schema is never worth failing a publish over.
  }

  // Both dates go to every adapter, and into every article as a visible
  // dateline, in the site's language (lib/content/trust.ts). Only here are
  // both known.
  const dateline = workspaceRead ? datelineHtml(language, { publishedAt: opts.publishedAt, modifiedAt: opts.modifiedAt }) : null;
  if (dateline) html = `${dateline}\n${html}`;

  return { html, structuredData, siteUrl, publisherName, language, indexNowKey };
}
