import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";
import { getHostedArticle } from "@/lib/hosted-blog/data";
import { breadcrumbJsonLd, jsonLdText, withArticleUrl } from "@/lib/hosted-blog/markup";
import { loadHostedBlog } from "@/lib/hosted-blog/request";
import { renderPublishedBody } from "@/lib/publishing/render";

type Props = { params: Promise<{ slug: string; article: string }> };

/** The site, the article and its address, once per request. */
const load = cache(async (slug: string, articleSlug: string) => {
  const loaded = await loadHostedBlog(slug);
  if (!loaded) return null;
  const article = await getHostedArticle(loaded.site.id, articleSlug);
  if (!article) return null;
  return { ...loaded, article, url: `${loaded.urls.canonicalRoot}/${encodeURIComponent(article.slug)}` };
});

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug, article: articleSlug } = await props.params;
  const loaded = await load(slug, articleSlug);
  if (!loaded) return { title: { absolute: "Not found" }, robots: { index: false, follow: false } };
  const { site, urls, article, url } = loaded;
  const description = article.meta_description ?? undefined;
  const images = article.featured_image_url ? [article.featured_image_url] : undefined;
  return {
    title: { absolute: `${article.title} | ${site.name}` },
    description,
    robots: urls.indexable ? undefined : { index: false, follow: true },
    alternates: { canonical: url, types: { "application/rss+xml": `${urls.canonicalRoot}/rss.xml` } },
    openGraph: {
      title: article.title,
      description,
      type: "article",
      url,
      siteName: site.name,
      publishedTime: article.published_at ?? undefined,
      modifiedTime: article.updated_at,
      images,
    },
    twitter: { card: images ? "summary_large_image" : "summary", title: article.title, description, images },
  };
}

export default async function HostedArticlePage(props: Props) {
  const { slug, article: articleSlug } = await props.params;
  const loaded = await load(slug, articleSlug);
  if (!loaded) notFound();
  const { site, urls, article, url } = loaded;

  // The body as every other destination gets it (lib/publishing/render.ts):
  // the title heading removed, links resolved, the free tier's attribution,
  // the dateline. The JSON-LD stays out of the body; the page emits it.
  const rendered = article.content
    ? await renderPublishedBody(createServiceClient(), { ...article, workspace_id: site.id }, article.id, {
        publishedAt: article.published_at ?? article.updated_at,
        modifiedAt: article.updated_at ?? article.published_at ?? article.updated_at,
        jsonLdInBodyFor: null,
      })
    : { html: "", structuredData: [] as object[] };

  const schemas = [
    ...withArticleUrl(rendered.structuredData, url),
    breadcrumbJsonLd([
      { name: site.name, url: urls.canonicalRoot },
      { name: article.title, url },
    ]),
  ];

  return (
    <article className="hb-article">
      {/* jsonLdText escapes every "<", so no value can close the tag. */}
      {schemas.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(s) }} />
      ))}
      <nav className="hb-crumbs" aria-label="Breadcrumb">
        <a href={urls.linkRoot || "/"}>← All articles</a>
      </nav>
      <h1 className="hb-article-title">{article.title}</h1>
      {article.meta_description && <p className="hb-lede">{article.meta_description}</p>}
      {article.featured_image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="hb-hero" src={article.featured_image_url} alt="" />
      )}
      {/* tiptapToHtml escapes every text and attribute value and passes URLs,
          embeds and SVG through lib/html/sanitize.ts: the same HTML the blog
          API and every CMS publish send out. */}
      <div className="hb-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
    </article>
  );
}
