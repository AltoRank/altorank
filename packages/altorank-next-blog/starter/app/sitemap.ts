import type { MetadataRoute } from "next";
import { BlogClient } from "@altorank/next-blog";

// /sitemap.xml with every live article. If your site already has an
// app/sitemap.ts, add the `articles` entries to it instead of copying this.
//
// Set NEXT_PUBLIC_SITE_URL (https://www.example.com) so the URLs are absolute,
// as sitemaps require.
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  const articles = await new BlogClient().listAll();
  return [
    { url: `${base}/blog`, changeFrequency: "daily" },
    ...articles.map((a) => ({
      url: `${base}/blog/${a.slug}`,
      lastModified: a.updated_at ?? a.published_at ?? undefined,
    })),
  ];
}
