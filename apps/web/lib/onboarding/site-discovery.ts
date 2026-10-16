// ---------------------------------------------------------------------------
// Find the sitemap and the blog, or say that we could not
// ---------------------------------------------------------------------------
//
// The first wizard printed `https://<domain>/sitemap.xml` under the words "We
// found these on your site". It had found nothing. Either sentence is fine on
// its own; together they teach the person that the product's claims are
// decorative. So this actually looks, in the order a crawler would: robots.txt
// first, then the conventional paths, and it reports `found: false` when it
// comes up empty so the screen can ask instead of assert.

import { e2eStubsEnabled, stubDiscoverSite } from "@/lib/e2e/stubs";
import { getSiteFile, looksLikePost, looksLikeSitemap as isSitemapBody, prioritiseSiteUrls, readSiteUrls, sitemapEntries } from "@/lib/seo/site-urls";

export interface SiteDiscovery {
  sitemapUrl: string | null;
  blogRootUrl: string | null;
  /** Article-looking URLs from the sitemap (or feed), newest first when the site dates them. */
  exampleArticleUrls: string[];
  /** True when at least one of sitemap / blog was verified live. */
  found: boolean;
}

const TIMEOUT_MS = 6_000;
/**
 * The whole walk, wall-clock. The wizard waits on this; past it the examples
 * come from whatever was read, and the onboarding run's page crawl, which
 * shares these fetches, reads the rest on its own budget.
 */
const WALK_MS = 15_000;
const BLOG_CANDIDATES = ["/blog/", "/blog", "/articles/", "/news/", "/insights/", "/resources/", "/journal/", "/posts/"];

/** `Sitemap:` lines from a robots.txt body. Exported for tests. */
export function sitemapsFromRobots(robots: string, origin: string): string[] {
  return robots
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*sitemap:\s*(\S+)/i)?.[1])
    .filter((u): u is string => Boolean(u))
    .map((u) => {
      try {
        return new URL(u, origin).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export function looksLikeSitemap(body: string): boolean {
  return isSitemapBody(body);
}

/**
 * URLs from one sitemap body that look like articles (lib/seo/site-urls.ts
 * looksLikePost), newest first where the sitemap dates them. `fromPostList`
 * when the caller knows the file lists only posts (`post-sitemap.xml`), so a
 * WordPress post at /my-post/ counts. Exported for tests.
 */
export function articleUrlsFromSitemap(body: string, limit = 3, opts: { fromPostList?: boolean } = {}): string[] {
  const entries = sitemapEntries(body).map((e) => ({ url: e.loc, lastmod: e.lastmod, fromPostList: Boolean(opts.fromPostList) }));
  const posts = prioritiseSiteUrls(entries, entries.length).filter((e) => looksLikePost(e.url, { fromPostList: e.fromPostList }));
  return [...new Set(posts.map((e) => e.url))].slice(0, limit);
}

export async function discoverSite(domain: string): Promise<SiteDiscovery> {
  // E2E_STUBS: a fixture sitemap and blog, no fetch (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubDiscoverSite(domain);
  const origin = domain.startsWith("http") ? domain.replace(/\/+$/, "") : `https://${domain.replace(/\/+$/, "")}`;
  const result: SiteDiscovery = { sitemapUrl: null, blogRootUrl: null, exampleArticleUrls: [], found: false };

  // 1. The sitemap, walked the way every other reader walks it and, inside an
  //    onboarding run, with the same fetches (lib/seo/site-urls.ts). The feed
  //    or the blog index stand in on a site without one.
  const read = await readSiteUrls(origin, { timeoutMs: TIMEOUT_MS, deadline: Date.now() + WALK_MS });
  result.sitemapUrl = read.sitemapUrl;
  result.exampleArticleUrls = prioritiseSiteUrls(read.urls, read.urls.length)
    .filter((e) => looksLikePost(e.url, { fromPostList: e.fromPostList }))
    .slice(0, 3)
    .map((e) => e.url);

  // 2. The blog root: what the fallback read, then what the posts imply, then the conventions.
  if (read.blogRootUrl) {
    result.blogRootUrl = read.blogRootUrl;
  } else {
    const implied = result.exampleArticleUrls
      .map((u) => u.match(/^(https?:\/\/[^/]+\/(?:blogs\/[^/]+|blog|articles?|news|insights|posts|journal|magazine|learn|guides?|resources))\//i)?.[1])
      .find(Boolean);
    const blogCandidates = [...(implied ? [`${implied}/`] : []), ...BLOG_CANDIDATES.map((p) => origin + p)];
    for (const url of [...new Set(blogCandidates)].slice(0, implied ? 2 : 5)) {
      const r = await getSiteFile(url, TIMEOUT_MS);
      // A candidate that 200s but lands back on the homepage is not a blog.
      if (r.body !== null && r.status === 200 && new URL(r.finalUrl).pathname.replace(/\/$/, "") !== "") {
        result.blogRootUrl = r.finalUrl.endsWith("/") ? r.finalUrl : `${r.finalUrl}/`;
        break;
      }
    }
  }

  result.found = Boolean(result.sitemapUrl || result.blogRootUrl);
  return result;
}
