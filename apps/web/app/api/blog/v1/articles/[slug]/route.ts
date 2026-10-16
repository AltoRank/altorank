import { ARTICLE_LIST_COLUMNS, authenticateBlogRequest, json } from "@/lib/blog-api/auth";
import { renderPublishedBody } from "@/lib/publishing/render";

export const dynamic = "force-dynamic";

/**
 * GET /api/blog/v1/articles/<slug>?workspace_id=<uuid>
 *
 * One live article with its body rendered to HTML through the same steps a
 * CMS publish runs (lib/publishing/render.ts): no repeated title heading,
 * internal links resolved, the free tier's attribution, the dateline. The
 * BlogPosting/FAQ JSON-LD comes back as `structured_data`, for the site to
 * emit in a script tag. Same `status = 'live'` rule as the list, and the same
 * exception: an article found live on the customer's own site is not served.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await authenticateBlogRequest(request);
  if (!auth.ok) return auth.response;

  const { slug } = await params;

  const { data, error } = await auth.supabase
    .from("articles")
    .select(`${ARTICLE_LIST_COLUMNS}, content`)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "live")
    .is("found_on_site_at", null)
    .eq("slug", slug)
    // Slugs are made unique per site when an article is created, but rows
    // from before that can share one. The most recently published wins, so
    // the page renders instead of the route failing the site's build.
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) return json({ error: "Could not read the article" }, { status: 500 });
  // `code` is what the client reads as "no such article" (null, so the page
  // 404s); every other failure throws and keeps the pages a site already has.
  if (!data) return json({ error: "Article not found", code: "article_not_found" }, { status: 404 });

  const row = data as Record<string, unknown> & {
    id: string;
    title: string;
    content: Record<string, unknown> | null;
    meta_description: string | null;
    featured_image_url: string | null;
    keyword: string | null;
    published_at: string | null;
    updated_at: string;
  };
  const { content, ...rest } = row;
  if (!content) return json({ article: { ...rest, content_html: "", structured_data: [] } });

  const rendered = await renderPublishedBody(
    auth.supabase,
    { ...row, workspace_id: auth.workspaceId },
    row.id,
    {
      // Live through "Mark as published" or a publish: published_at is the
      // day it went out. The text served is the row's current text, so its
      // modified date is the row's.
      publishedAt: row.published_at ?? row.updated_at,
      modifiedAt: row.updated_at ?? row.published_at,
      jsonLdInBodyFor: null,
    },
  );
  return json({
    article: {
      ...rest,
      content_html: rendered.html,
      structured_data: rendered.structuredData,
    },
  });
}
