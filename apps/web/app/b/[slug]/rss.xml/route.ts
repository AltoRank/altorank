import { hostedFeedResponse } from "@/lib/hosted-blog/feed-response";
import { rssXml } from "@/lib/hosted-blog/markup";

export const dynamic = "force-dynamic";

/** The latest 50, newest first. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return hostedFeedResponse(request, slug, "application/rss+xml", rssXml, 50);
}
