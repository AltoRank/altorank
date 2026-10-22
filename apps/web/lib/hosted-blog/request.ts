import { cache } from "react";
import { headers } from "next/headers";
import { getHostedSite, hostedBlogUrls } from "@/lib/hosted-blog/data";

/**
 * The site behind /b/<slug> and its addresses for this request, read once per
 * request: the layout, the page and generateMetadata all ask.
 */
export const loadHostedBlog = cache(async (slug: string) => {
  const site = await getHostedSite(slug);
  if (!site) return null;
  const host = (await headers()).get("host");
  return { site, urls: hostedBlogUrls(site, host) };
});

/** Dates as the site's readers write them. */
export function formatDate(iso: string | null, language: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(language || "en", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  }
}
