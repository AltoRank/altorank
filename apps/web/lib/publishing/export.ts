// ---------------------------------------------------------------------------
// The article as a file: what "publish it yourself" hands over
// ---------------------------------------------------------------------------
//
// `markPublishedManually` was written with the sentence "here is the file,
// commit it yourself" in its comment, and then only ever offered the HTML. A
// Next.js, Astro or Hugo site wants a Markdown file with front matter, and a
// person pasting into a hand-built CMS wants HTML. Both come from the same
// content, so both are one function each, pure, and safe to run in the
// browser: the click that copies is the click that renders, which is also what
// keeps the clipboard write inside the user gesture Safari insists on.

import { buildFrontmatter } from "@/lib/cms/frontmatter";
import { htmlToMarkdown } from "@/lib/audit/markdown";

export type ExportableArticle = {
  title: string;
  slug: string;
  html: string;
  metaDescription?: string | null;
  keyword?: string | null;
  featuredImageUrl?: string | null;
  /** ISO date; today when omitted. */
  publishedAt?: string | null;
};

/**
 * Markdown with front matter, the shape the git adapter commits.
 *
 * `siteUrl` resolves relative links inside the body to absolute ones, so a
 * link the writer made to /pricing survives being pasted into another host.
 */
export function renderArticleMarkdown(article: ExportableArticle, siteUrl: string): string {
  const { markdown } = htmlToMarkdown(article.html, siteUrl);
  const frontmatter = buildFrontmatter({
    title: article.title,
    description: article.metaDescription ?? undefined,
    slug: article.slug,
    publishDate: (article.publishedAt ?? new Date().toISOString()).slice(0, 10),
    keyword: article.keyword ?? undefined,
    ogImage: article.featuredImageUrl ?? undefined,
  });
  return `${frontmatter}\n${markdown.trim()}\n`;
}
