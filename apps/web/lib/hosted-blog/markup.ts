import type { HostedArticleSummary, HostedSite } from "@/lib/hosted-blog/data";

// ---------------------------------------------------------------------------
// The hosted blog's structured data and feeds, as plain strings and objects
// ---------------------------------------------------------------------------

/** JSON for a <script type="application/ld+json">: every `<` escaped, so no value can close the tag. */
export function jsonLdText(schema: object): string {
  return JSON.stringify(schema).replace(/</g, "\\u003c");
}

/**
 * The BlogPosting the body was rendered with (lib/publishing/schema.ts), now
 * that its address is known: `url` and `mainEntityOfPage`, which a publish to
 * a CMS cannot fill in because the far side picks the URL.
 */
export function withArticleUrl(structuredData: object[], url: string): object[] {
  return structuredData.map((s) =>
    (s as { "@type"?: string })["@type"] === "BlogPosting"
      ? { ...s, url, mainEntityOfPage: { "@type": "WebPage", "@id": url } }
      : s,
  );
}

export function breadcrumbJsonLd(items: Array<{ name: string; url: string }>): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
  };
}

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export function sitemapXml(root: string, articles: Pick<HostedArticleSummary, "slug" | "updated_at" | "published_at">[]): string {
  const latest = articles[0]?.updated_at ?? articles[0]?.published_at;
  const urls = [
    `<url><loc>${xml(root)}</loc>${latest ? `<lastmod>${xml(latest)}</lastmod>` : ""}</url>`,
    ...articles.map((a) => {
      const lastmod = a.updated_at ?? a.published_at;
      return `<url><loc>${xml(`${root}/${encodeURIComponent(a.slug)}`)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ""}</url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function rssXml(
  site: Pick<HostedSite, "name" | "domain" | "language">,
  root: string,
  articles: Pick<HostedArticleSummary, "slug" | "title" | "meta_description" | "published_at" | "updated_at">[],
): string {
  const items = articles.map((a) => {
    const link = `${root}/${encodeURIComponent(a.slug)}`;
    const date = a.published_at ?? a.updated_at;
    return [
      "<item>",
      `<title>${xml(a.title)}</title>`,
      `<link>${xml(link)}</link>`,
      `<guid isPermaLink="true">${xml(link)}</guid>`,
      date ? `<pubDate>${new Date(date).toUTCString()}</pubDate>` : "",
      a.meta_description ? `<description>${xml(a.meta_description)}</description>` : "",
      "</item>",
    ].join("");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xml(site.name)}</title>`,
    `<link>${xml(root)}</link>`,
    `<description>${xml(`Articles from ${site.domain}`)}</description>`,
    site.language ? `<language>${xml(site.language)}</language>` : "",
    `<atom:link href="${xml(`${root}/rss.xml`)}" rel="self" type="application/rss+xml"/>`,
    ...items,
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}
