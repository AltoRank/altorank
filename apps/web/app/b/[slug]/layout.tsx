import { notFound } from "next/navigation";
import { loadHostedBlog } from "@/lib/hosted-blog/request";
import "./hosted-blog.css";

/**
 * The hosted blog's shell (migration 120): the site's name, its articles,
 * nothing of the app. Public and sessionless; a slug with no blog behind it,
 * or one switched off, is a 404.
 */
export const dynamic = "force-dynamic";

export default async function HostedBlogLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loaded = await loadHostedBlog(slug);
  if (!loaded) notFound();
  const { site, urls } = loaded;

  return (
    <div
      className="hosted-blog"
      lang={site.language ?? undefined}
      style={site.accent ? ({ "--blog-accent": site.accent } as React.CSSProperties) : undefined}
    >
      <header className="hb-header">
        <div className="hb-wrap hb-header-row">
          <a href={urls.linkRoot || "/"} className="hb-brand">
            <span className="hb-dot" aria-hidden />
            <span className="hb-brand-name">{site.name}</span>
          </a>
          <a href={`https://${site.domain}`} className="hb-out">
            {site.domain}
          </a>
        </div>
      </header>
      <main className="hb-wrap hb-main">{children}</main>
      <footer className="hb-wrap">
        <div className="hb-footer">
          <span>
            © {new Date().getFullYear()} {site.name}
          </span>
          <a href={`${urls.linkRoot}/rss.xml`}>RSS</a>
        </div>
      </footer>
    </div>
  );
}
