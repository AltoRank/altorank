import { getHostedSite, hostedBlogUrls, listHostedArticles, type HostedSite } from "@/lib/hosted-blog/data";

/** Most articles a feed or sitemap lists: PostgREST's default page, and far past any site's blog today. */
const FEED_LIMIT = 1000;

/**
 * sitemap.xml and rss.xml for /b/<slug>: the same rows as the index, the
 * same 404 for a blog that is off, and noindex on the preview path, as the
 * pages carry it in their head.
 */
export async function hostedFeedResponse(
  request: Request,
  slug: string,
  contentType: string,
  build: (site: HostedSite, root: string, articles: Awaited<ReturnType<typeof listHostedArticles>>["articles"]) => string,
  limit = FEED_LIMIT,
): Promise<Response> {
  const site = await getHostedSite(slug);
  if (!site) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const urls = hostedBlogUrls(site, request.headers.get("host"));
  const { articles } = await listHostedArticles(site.id, 1, undefined, limit);
  const headers: Record<string, string> = {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "public, max-age=0, s-maxage=300",
  };
  if (!urls.indexable) headers["X-Robots-Tag"] = "noindex";
  return new Response(build(site, urls.canonicalRoot, articles), { headers });
}
