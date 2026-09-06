import Link from "next/link";
import { BlogClient } from "@altorank/next-blog";

// Regenerated at most once a day. Publishing in the dashboard shows up here
// on the next request after that, or immediately if you call
// revalidatePath("/blog") from a webhook.
export const revalidate = 86400;

export default async function BlogIndex() {
  const client = new BlogClient();
  const { articles } = await client.list({ perPage: 50 });

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
    </main>
  );
}
