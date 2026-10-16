import { hostedFeedResponse } from "@/lib/hosted-blog/feed-response";
import { sitemapXml } from "@/lib/hosted-blog/markup";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return hostedFeedResponse(request, slug, "application/xml", (_site, root, articles) => sitemapXml(root, articles));
}
