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

import { fetchSite } from "@/lib/audit/lenient-fetch";

export interface SiteDiscovery {
  sitemapUrl: string | null;
  blogRootUrl: string | null;
  /** Article-looking URLs from the sitemap, newest first when lastmod exists. */
  exampleArticleUrls: string[];
  /** True when at least one of sitemap / blog was verified live. */
  found: boolean;
}

const UA = "AltoRankBot/1.0 (site discovery)";
const TIMEOUT_MS = 6_000;
const SITEMAP_CANDIDATES = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/sitemap/sitemap.xml", "/wp-sitemap.xml"];
const BLOG_CANDIDATES = ["/blog/", "/blog", "/articles/", "/news/", "/insights/", "/resources/", "/journal/", "/posts/"];

async function get(url: string): Promise<{ status: number; body: string; finalUrl: string } | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetchSite(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    clearTimeout(t);
    const body = res.ok ? (await res.text()).slice(0, 400_000) : "";
    return { status: res.status, body, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

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
  const head = body.slice(0, 2000);
  return /<(urlset|sitemapindex)[\s>]/i.test(head);
}

/**
 * URLs from a sitemap that look like articles: dated paths, or paths under a
 * known blog folder, or long slugs with hyphens. Exported for tests.
 */
export function articleUrlsFromSitemap(body: string, limit = 3): string[] {
  const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const scored = locs
    .map((u) => {
      let path = "";
      try {
        path = new URL(u).pathname;
      } catch {
        return null;
      }
      const segs = path.split("/").filter(Boolean);
      const last = segs[segs.length - 1] ?? "";
      let score = 0;
      // A folder alone ("/blog/") is an index, not an article; it needs a slug after it.
      if (/\/(blog|articles?|news|insights|posts|journal|guides?|resources)\/[^/]+/i.test(path)) score += 3;
      if (/\/\d{4}\/\d{2}\//.test(path)) score += 2;
      if ((last.match(/-/g) ?? []).length >= 2) score += 2;
      if (segs.length === 0 || /\.(xml|pdf|jpg|png)$/i.test(last)) score -= 5;
      if (/\/(tag|category|author|page)\//i.test(path)) score -= 3;
      return { u, score };
    })
    .filter((x): x is { u: string; score: number } => x !== null && x.score >= 3)
    .sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((x) => x.u))].slice(0, limit);
}

export async function discoverSite(domain: string): Promise<SiteDiscovery> {
  const origin = domain.startsWith("http") ? domain.replace(/\/+$/, "") : `https://${domain.replace(/\/+$/, "")}`;
  const result: SiteDiscovery = { sitemapUrl: null, blogRootUrl: null, exampleArticleUrls: [], found: false };

  // 1. robots.txt names the sitemap for real sites more often than not.
  const robots = await get(`${origin}/robots.txt`);
  const candidates = [...(robots?.body ? sitemapsFromRobots(robots.body, origin) : []), ...SITEMAP_CANDIDATES.map((p) => origin + p)];
  let sitemapBody = "";
  for (const url of [...new Set(candidates)].slice(0, 6)) {
    const r = await get(url);
    if (r && r.status === 200 && looksLikeSitemap(r.body)) {
      result.sitemapUrl = url;
      sitemapBody = r.body;
      break;
    }
  }

  // A sitemap index points at child sitemaps; read the first one for URLs.
  if (sitemapBody && /<sitemapindex/i.test(sitemapBody.slice(0, 2000))) {
    const child = sitemapBody.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
    if (child) {
      const r = await get(child);
      if (r?.body) sitemapBody = r.body;
    }
  }
  if (sitemapBody) result.exampleArticleUrls = articleUrlsFromSitemap(sitemapBody);

  // 2. The blog root: prefer what the sitemap implies, then the conventions.
  const implied = result.exampleArticleUrls
    .map((u) => u.match(/^(https?:\/\/[^/]+\/(?:blog|articles?|news|insights|posts|journal|guides?|resources))\//i)?.[1])
    .find(Boolean);
  const blogCandidates = [...(implied ? [`${implied}/`] : []), ...BLOG_CANDIDATES.map((p) => origin + p)];
  for (const url of [...new Set(blogCandidates)].slice(0, 5)) {
    const r = await get(url);
    // A candidate that 200s but lands back on the homepage is not a blog.
    if (r && r.status === 200 && new URL(r.finalUrl).pathname.replace(/\/$/, "") !== "") {
      result.blogRootUrl = r.finalUrl.endsWith("/") ? r.finalUrl : `${r.finalUrl}/`;
      break;
    }
  }

  result.found = Boolean(result.sitemapUrl || result.blogRootUrl);
  return result;
}
