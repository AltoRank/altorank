// Four sites, shaped like the ones real first looks met, served from memory.
// Each lists its posts newest first: that is the ground truth the coverage
// tests measure the readers against.

export interface FixtureSite {
  name: string;
  domain: string;
  /** URL to body. A URL absent here answers 404. */
  files: Record<string, string>;
  /** Every post the site has, newest first. */
  posts: string[];
}

const urlset = (entries: Array<{ loc: string; lastmod?: string }>) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  entries.map((e) => `<url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`).join("") +
  `</urlset>`;

const sitemapIndex = (entries: Array<{ loc: string; lastmod?: string }>) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  entries.map((e) => `<sitemap><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</sitemap>`).join("") +
  `</sitemapindex>`;

const html = (body: string, head = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

/** Day `n` days before 2026-10-01, ISO. */
const daysAgo = (n: number) => new Date(Date.UTC(2026, 9, 1) - n * 86_400_000).toISOString();

// ── WordPress + Yoast: a sitemap index, posts at the root, oldest first ─────

function wordpress(): FixtureSite {
  const origin = "https://wp.example";
  const count = 120;
  // Post i was published i days ago; Yoast lists the oldest first.
  const posts = Array.from({ length: count }, (_, i) => ({
    loc: `${origin}/how-to-${["fix", "plan", "choose", "price", "audit"][i % 5]}-a-thing-number-${i}/`,
    lastmod: daysAgo(i),
  }));
  const oldestFirst = [...posts].reverse();
  return {
    name: "WordPress (Yoast sitemap_index, root-level posts)",
    domain: "wp.example",
    files: {
      [`${origin}/robots.txt`]: `User-agent: *\nDisallow: /wp-admin/\nSitemap: ${origin}/sitemap_index.xml\n`,
      [`${origin}/sitemap_index.xml`]: sitemapIndex([
        { loc: `${origin}/page-sitemap.xml`, lastmod: daysAgo(40) },
        { loc: `${origin}/category-sitemap.xml`, lastmod: daysAgo(1) },
        { loc: `${origin}/author-sitemap.xml`, lastmod: daysAgo(2) },
        { loc: `${origin}/post-sitemap.xml`, lastmod: daysAgo(0) },
      ]),
      [`${origin}/page-sitemap.xml`]: urlset([
        { loc: `${origin}/` },
        { loc: `${origin}/about/` },
        { loc: `${origin}/pricing/` },
        { loc: `${origin}/contact/` },
        { loc: `${origin}/services/` },
      ]),
      [`${origin}/category-sitemap.xml`]: urlset([{ loc: `${origin}/category/news/` }, { loc: `${origin}/category/guides/` }]),
      [`${origin}/author-sitemap.xml`]: urlset([{ loc: `${origin}/author/admin/` }]),
      [`${origin}/post-sitemap.xml`]: urlset(oldestFirst),
    },
    posts: posts.map((p) => p.loc),
  };
}

// ── Shopify: products first in the index, posts under /blogs/news/ ─────────

function shopify(): FixtureSite {
  const origin = "https://shop.example";
  const products = Array.from({ length: 3_000 }, (_, i) => ({ loc: `${origin}/products/widget-${i}`, lastmod: daysAgo(i % 30) }));
  const posts = Array.from({ length: 30 }, (_, i) => ({ loc: `${origin}/blogs/news/care-guide-part-${i}`, lastmod: daysAgo(i * 3) }));
  const productFiles: Record<string, string> = {};
  const productIndex: Array<{ loc: string }> = [];
  for (let f = 0; f < 6; f++) {
    const loc = `${origin}/sitemap_products_${f + 1}.xml?from=${f * 500}&to=${f * 500 + 499}`;
    productIndex.push({ loc });
    productFiles[loc] = urlset(products.slice(f * 500, f * 500 + 500));
  }
  return {
    name: "Shopify (product sitemaps listed first, /blogs/news/)",
    domain: "shop.example",
    files: {
      [`${origin}/robots.txt`]: `User-agent: *\nDisallow: /cart\nSitemap: ${origin}/sitemap.xml\n`,
      [`${origin}/sitemap.xml`]: sitemapIndex([
        ...productIndex,
        { loc: `${origin}/sitemap_pages_1.xml` },
        { loc: `${origin}/sitemap_collections_1.xml` },
        { loc: `${origin}/sitemap_blogs_1.xml` },
      ]),
      ...productFiles,
      [`${origin}/sitemap_pages_1.xml`]: urlset([{ loc: `${origin}/pages/about` }, { loc: `${origin}/pages/contact` }]),
      [`${origin}/sitemap_collections_1.xml`]: urlset([{ loc: `${origin}/collections/all` }]),
      // Shopify lists the blog index itself, then the posts.
      [`${origin}/sitemap_blogs_1.xml`]: urlset([{ loc: `${origin}/blogs/news` }, ...posts]),
    },
    posts: posts.map((p) => p.loc),
  };
}

// ── Hand-built, no sitemap: a feed for the newest, a paginated blog for the rest

function noSitemap(): FixtureSite {
  const origin = "https://plain.example";
  const all = Array.from({ length: 25 }, (_, i) => `${origin}/blog/notes-on-thing-${i}`);
  const page = (n: number) => {
    const slice = all.slice((n - 1) * 10, n * 10);
    const next = n * 10 < all.length ? `<a rel="next" href="/blog/page/${n + 1}/">Older</a>` : "";
    return html(`<nav><a href="/">Home</a><a href="/blog/">Blog</a><a href="/contact">Contact</a></nav>` + slice.map((u) => `<a href="${u}">post</a>`).join("") + next);
  };
  return {
    name: "Hand-built, no sitemap, paginated /blog/",
    domain: "plain.example",
    files: {
      [`${origin}/robots.txt`]: "User-agent: *\nDisallow:\n",
      [`${origin}/`]: html(`<a href="/blog/">Blog</a><a href="/contact">Contact</a>`),
      [`${origin}/blog/`]: page(1),
      [`${origin}/blog/page/2/`]: page(2),
      [`${origin}/blog/page/3/`]: page(3),
    },
    posts: all,
  };
}

function noSitemapWithFeed(): FixtureSite {
  const origin = "https://feed.example";
  const posts = Array.from({ length: 12 }, (_, i) => ({ loc: `${origin}/journal/entry-${i}`, date: new Date(Date.UTC(2026, 8, 30 - i)).toUTCString() }));
  return {
    name: "No sitemap, RSS feed declared on the homepage",
    domain: "feed.example",
    files: {
      [`${origin}/`]: html(`<a href="/journal/">Journal</a>`, `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`),
      [`${origin}/feed.xml`]:
        `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>` +
        posts.map((p) => `<item><title>t</title><link>${p.loc}</link><pubDate>${p.date}</pubDate></item>`).join("") +
        `</channel></rss>`,
    },
    posts: posts.map((p) => p.loc),
  };
}

// ── A subfolder blog under a name the old list missed ──────────────────────

function magazine(): FixtureSite {
  const origin = "https://mag.example";
  const posts = Array.from({ length: 50 }, (_, i) => ({ loc: `${origin}/magazine/story-${i}`, lastmod: daysAgo(i * 2) }));
  // Marketing pages first and posts oldest first, the way many CMSes write it.
  const marketing = ["", "features", "pricing", "about", "customers", "integrations", "security", "careers", "contact", "partners"]
    .map((p) => ({ loc: `${origin}/${p}` }));
  return {
    name: "Subfolder blog at /magazine/",
    domain: "mag.example",
    files: {
      [`${origin}/robots.txt`]: `User-agent: *\nSitemap: ${origin}/sitemap.xml\n`,
      [`${origin}/sitemap.xml`]: urlset([...marketing, ...[...posts].reverse()]),
    },
    posts: posts.map((p) => p.loc),
  };
}

export const FIXTURE_SITES: FixtureSite[] = [wordpress(), shopify(), noSitemap(), noSitemapWithFeed(), magazine()];

/**
 * A `fetch` that serves a fixture site and counts what was asked of it. URLs
 * are matched exactly, so a request the old code made under another spelling
 * is a 404, as it would be on the real site.
 */
export function serveFixture(site: FixtureSite): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    const body = site.files[url];
    if (body === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const type = /\.xml|robots\.txt|sitemap/.test(url) ? "application/xml" : "text/html; charset=utf-8";
    const res = new Response(body, { status: 200, headers: { "content-type": type } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  return { fetch: f, requests };
}
