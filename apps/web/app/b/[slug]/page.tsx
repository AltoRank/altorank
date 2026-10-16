import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listHostedArticles, PER_PAGE } from "@/lib/hosted-blog/data";
import { formatDate, loadHostedBlog } from "@/lib/hosted-blog/request";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ page?: string }> };

function pageOf(raw: string | undefined): number {
  const n = Number(raw ?? "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ slug }, { page }] = await Promise.all([props.params, props.searchParams]);
  const loaded = await loadHostedBlog(slug);
  if (!loaded) return { title: { absolute: "Not found" }, robots: { index: false, follow: false } };
  const { site, urls } = loaded;
  const n = pageOf(page);
  const title = n > 1 ? `${site.name} blog · page ${n}` : `${site.name} blog`;
  const description = `Articles from ${site.domain}.`;
  return {
    title: { absolute: title },
    description,
    robots: urls.indexable ? undefined : { index: false, follow: true },
    alternates: {
      canonical: n > 1 ? `${urls.canonicalRoot}?page=${n}` : urls.canonicalRoot,
      types: { "application/rss+xml": `${urls.canonicalRoot}/rss.xml` },
    },
    openGraph: { title, description, type: "website", siteName: site.name },
  };
}

export default async function HostedBlogIndex(props: Props) {
  const [{ slug }, { page }] = await Promise.all([props.params, props.searchParams]);
  const loaded = await loadHostedBlog(slug);
  if (!loaded) notFound();
  const { site, urls } = loaded;

  const n = pageOf(page);
  const { articles, total } = await listHostedArticles(site.id, n);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (n > pages) notFound();

  return (
    <>
      <div className="hb-intro">
        <p className="hb-eyebrow">Blog</p>
        <h1 className="hb-title">{site.name}</h1>
      </div>

      {articles.length === 0 ? (
        <p className="hb-empty">No articles yet.</p>
      ) : (
        <ol className="hb-list">
          {articles.map((a) => (
            <li key={a.id}>
              <a href={`${urls.linkRoot}/${encodeURIComponent(a.slug)}`} className="hb-item">
                <time className="hb-date" dateTime={a.published_at ?? a.updated_at}>
                  {formatDate(a.published_at ?? a.updated_at, site.language)}
                </time>
                <h2 className="hb-item-title">{a.title}</h2>
                {a.meta_description && <p className="hb-excerpt">{a.meta_description}</p>}
              </a>
            </li>
          ))}
        </ol>
      )}

      {pages > 1 && (
        <nav className="hb-pager" aria-label="Pages">
          {n > 1 ? (
            <a href={n === 2 ? urls.linkRoot || "/" : `${urls.linkRoot || ""}?page=${n - 1}`} rel="prev">
              ← Newer
            </a>
          ) : (
            <span />
          )}
          <span className="hb-pager-count">
            {n} / {pages}
          </span>
          {n < pages ? (
            <a href={`${urls.linkRoot || ""}?page=${n + 1}`} rel="next">
              Older →
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
