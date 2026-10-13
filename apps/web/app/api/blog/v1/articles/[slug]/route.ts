import { ARTICLE_LIST_COLUMNS, authenticateBlogRequest, json } from "@/lib/blog-api/auth";
import { tiptapToHtml } from "@/lib/cms/html";

export const dynamic = "force-dynamic";

/**
 * GET /api/blog/v1/articles/<slug>?workspace_id=<uuid>
 *
 * One live article with its body rendered to HTML, the same rendering every
 * CMS adapter publishes. Same `status = 'live'` rule as the list, and the same
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
    .maybeSingle();

  if (error) return json({ error: error.message }, { status: 500 });
  if (!data) return json({ error: "Article not found" }, { status: 404 });

  const { content, ...rest } = data as Record<string, unknown> & { content: Record<string, unknown> | null };
  return json({
    article: {
      ...rest,
      content_html: content ? tiptapToHtml(content) : "",
    },
  });
}
