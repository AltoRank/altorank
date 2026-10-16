import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogClient } from "@altorank/next-blog";

// Regenerated at most once a day. Publishing in the dashboard shows up here
// on the next request after that, or immediately if you call
// revalidatePath("/blog") from a webhook.
export const revalidate = 86400;

const PER_PAGE = 20;

type Props = { searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const page = pageNumber((await searchParams).page);
  return {
    title: page > 1 ? `Blog - page ${page}` : "Blog",
    alternates: { canonical: page > 1 ? `/blog?page=${page}` : "/blog" },
  };
}

function pageNumber(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export default async function BlogIndex({ searchParams }: Props) {
  const page = pageNumber((await searchParams).page);
  const { articles, total } = await new BlogClient().list({ page, perPage: PER_PAGE });
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (page > pages) notFound();

  return (
    <main>
      <h1>Blog</h1>
      {articles.length === 0 && <p>No articles yet.</p>}
      <ul>
        {articles.map((a) => (
          <li key={a.id}>
            <Link href={`/blog/${a.slug}`}>{a.title}</Link>
            {a.meta_description && <p>{a.meta_description}</p>}
            {a.published_at && (
              <time dateTime={a.published_at}>
                {new Date(a.published_at).toLocaleDateString()}
              </time>
            )}
          </li>
        ))}
      </ul>
      {/* Every article is linked from some page of the index, so none is an
          orphan once the blog passes one page. */}
      {pages > 1 && (
        <nav aria-label="Blog pages">
          {page > 1 && <Link href={page === 2 ? "/blog" : `/blog?page=${page - 1}`}>Newer</Link>}{" "}
          <span>
            Page {page} of {pages}
          </span>{" "}
          {page < pages && <Link href={`/blog?page=${page + 1}`}>Older</Link>}
        </nav>
      )}
    </main>
  );
}
