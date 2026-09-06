import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogClient } from "@altorank/next-blog";

export const revalidate = 86400;

type Props = { params: Promise<{ slug: string }> };

const client = () => new BlogClient();

export async function generateStaticParams() {
  const articles = await client().listAll();
  return articles.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = await client().get(slug);
  if (!article) return {};
  return {
    title: article.title,
    description: article.meta_description ?? undefined,
    openGraph: article.featured_image_url ? { images: [article.featured_image_url] } : undefined,
  };
}

export default async function BlogArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = await client().get(slug);
  if (!article) notFound();

  return (
    <article>
      <h1>{article.title}</h1>
      {article.featured_image_url && (
        // eslint-disable-next-line @next/next/no-img-element -- swap for next/image once the host is in images.remotePatterns
        <img src={article.featured_image_url} alt="" />
      )}
      {/* The HTML was written by your dashboard and approved by you; it is the
          same body every CMS adapter publishes. */}
      <div dangerouslySetInnerHTML={{ __html: article.content_html }} />
    </article>
  );
}
