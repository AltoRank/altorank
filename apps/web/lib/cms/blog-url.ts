// ---------------------------------------------------------------------------
// Where a static site's posts actually live
// ---------------------------------------------------------------------------
//
// The git adapter commits a Markdown file and then has to say where that file
// will appear once the site rebuilds. It cannot ask: a commit is not a publish,
// and the URL is a convention of the host's routing, not something the GitHub
// API knows. Before this module it guessed - `publicBaseUrl` + the slug - and
// the guess went straight into `articles.published_url` and on to IndexNow.
//
// A site that has ever published a post has already answered the question, in
// its own sitemap. `https://example.com/blog/hello-world` tells you the prefix
// is `/blog` without anybody typing it. That is observed, not assumed, which is
// the only kind of claim this repo is willing to store.
//
// Reads public information only: robots.txt, the sitemap, and a HEAD. Runs at
// connect time (to prefill and validate) and after a build (to confirm).

import { fetchSite } from "@/lib/audit/lenient-fetch";

const UA =
  "Mozilla/5.0 (compatible; AltoRank-BlogURL/1.0; " +
  "+https://altorank.co; publishing setup)";

/** Bounds. A sitemap index can fan out to hundreds of files; we want a prefix, not a crawl. */
const MAX_SITEMAPS = 3;
const MAX_URLS = 2000;
const TIMEOUT_MS = 10_000;

/**
 * Path segments that name a blog. Ordered: an exact match on one of these wins
 * over a merely-popular directory, because a marketing site's biggest folder is
 * usually /products or a locale, not its posts.
 */
const BLOG_SEGMENTS = [
  "blog",
  "posts",
  "post",
  "articles",
  "article",
  "news",
  "insights",
  "guides",
  "resources",
  "stories",
];

export type BlogUrlDerivation = {
  /** Origin + post directory, no trailing slash, e.g. "https://example.com/blog". */
  baseUrl: string;
  /** Real post URLs this was read off. Shown to the user so the claim is checkable. */
  samples: string[];
  /** How it was decided, for the connect UI. */
  evidence: string;
};

async function get(url: string): Promise<Response | null> {
  try {
    return await fetchSite(url, {
      headers: { "User-Agent": UA },
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

async function bodyOf(url: string): Promise<string | null> {
  const res = await get(url);
  if (!res || !res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/** `<loc>` values, which is all we need from either a sitemap or a sitemap index. */
function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].replace(/&amp;/g, "&"));
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

/**
 * Sitemap locations, cheapest first: robots.txt declares them, and only if it
 * does not do we fall back to the conventional paths.
 */
async function findSitemaps(origin: string): Promise<string[]> {
  const declared: string[] = [];

  const robots = await bodyOf(`${origin}/robots.txt`);
  if (robots) {
    for (const line of robots.split("\n")) {
      const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
      if (m) declared.push(m[1]);
    }
  }

  if (declared.length) return declared.slice(0, MAX_SITEMAPS);
  return [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`];
}

/** Follows one level of sitemap index. Deeper nesting is rare and not worth the fan-out. */
async function collectUrls(origin: string): Promise<string[]> {
  const urls: string[] = [];

  for (const sitemap of await findSitemaps(origin)) {
    const body = await bodyOf(sitemap);
    if (!body) continue;
    const locs = extractLocs(body);

    // A sitemap index lists sitemaps, not pages. Telling them apart by
    // extension is imperfect but cheap, and a wrong guess costs one fetch.
    const nested = locs.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
    if (nested.length && nested.length === locs.length) {
      for (const child of nested.slice(0, MAX_SITEMAPS)) {
        const childBody = await bodyOf(child);
        if (childBody) urls.push(...extractLocs(childBody));
        if (urls.length >= MAX_URLS) break;
      }
    } else {
      urls.push(...locs);
    }

    if (urls.length >= MAX_URLS) break;
  }

  return urls.slice(0, MAX_URLS);
}

/**
 * Read the post directory off a site's own sitemap.
 *
 * Returns null when the site has no sitemap, or has one with no recognisable
 * post directory - a brand new site with nothing published yet, which is a real
 * case and not an error. The caller then asks the user, as before.
 */
export async function deriveBlogBaseUrl(
  siteUrl: string,
): Promise<BlogUrlDerivation | null> {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return null;
  }

  const urls = await collectUrls(origin);
  if (!urls.length) return null;

  // Group by parent path: /blog/hello -> /blog. Depth-1 pages (/about) have no
  // parent directory and are never posts, so they drop out here.
  const byParent = new Map<string, string[]>();
  const counts = new Map<string, number>();

  for (const raw of urls) {
    let path: string;
    try {
      const u = new URL(raw, origin);
      if (u.origin !== origin) continue;
      path = u.pathname;
    } catch {
      continue;
    }

    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2) continue;

    const parent = `/${segments.slice(0, -1).join("/")}`;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
    const list = byParent.get(parent) ?? [];
    if (list.length < 5) list.push(`${origin}${path}`);
    byParent.set(parent, list);
  }

  if (!byParent.size) return null;

  const counted = [...byParent.entries()].map(([parent, samples]) => ({
    parent,
    samples,
    count: counts.get(parent) ?? samples.length,
  }));

  // A named blog directory beats a bigger anonymous one. `/blog` with three
  // posts is the answer even when `/products` has four hundred.
  const named = counted
    .filter((c) => {
      const last = c.parent.split("/").filter(Boolean).pop() ?? "";
      return BLOG_SEGMENTS.includes(last.toLowerCase());
    })
    .sort((a, b) => b.count - a.count)[0];

  const chosen = named ?? [...counted].sort((a, b) => b.count - a.count)[0];
  if (!chosen) return null;

  return {
    baseUrl: `${origin}${chosen.parent}`,
    samples: chosen.samples.slice(0, 3),
    evidence: named
      ? `Sitemap lists posts under ${chosen.parent}`
      : `Sitemap's largest section is ${chosen.parent}; no /blog-style directory found`,
  };
}

/**
 * Does this URL exist yet?
 *
 * Deliberately not called at publish time. A git commit triggers a build, and
 * Netlify, Vercel and Cloudflare Pages all take tens of seconds to minutes, so
 * immediately after a commit the answer is "no" for every site on earth and
 * proves nothing. Used at connect time against a URL the sitemap already
 * listed, and again once a build has had time to run.
 *
 * A plain GET, not a HEAD: fetchSite() does not take a method, and several
 * static hosts answer HEAD with 405 while serving the page fine, so a HEAD
 * would have to be retried as a GET on anything but a 404 anyway. One request
 * against one static page is cheap enough not to optimise.
 */
export async function urlIsLive(url: string): Promise<boolean> {
  const res = await get(url);
  return res?.ok ?? false;
}
