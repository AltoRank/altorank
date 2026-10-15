// ---------------------------------------------------------------------------
// What a site has published, read once
// ---------------------------------------------------------------------------
//
// A first look on 2026-10-15 read the same sitemap four or five times: the
// wizard's discovery, the readiness check, the ranked-keyword filter, the
// page crawl and the link pool each walked it with a fetcher of their own.
// On a host that bans after about ten requests in forty seconds, that is half
// the allowance spent re-reading one file. And each walker read it a little
// differently: one level of index nesting, no `lastmod`, child sitemaps in
// whatever order the index listed them, so a Shopify store's 3,000 product
// URLs filled the list before its blog was reached and a WordPress site's
// newest posts sat behind its oldest.
//
// Two things here:
//
//   `withSiteReads`  a scope (AsyncLocalStorage, like lib/billing/spend-scope)
//                    inside which every robots.txt, sitemap and feed body is
//                    fetched once, however many readers ask and however
//                    concurrently. Outside a scope nothing is cached: the
//                    nightly cron and the tests see a plain fetch.
//
//   `readSiteUrls`   the one walk. Robots.txt, then the sitemap (an index of
//                    indexes is followed, post sitemaps first), with each
//                    URL's `lastmod`. A site with no sitemap falls back to the
//                    feed its homepage declares, then to its blog index and
//                    the next two pages of it.

import { AsyncLocalStorage } from "node:async_hooks";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { decodeEntities } from "@/lib/audit/html-utils";
import { refusing } from "@/lib/audit/host-circuit";
import { POST_SEGMENTS } from "@/lib/audit/site-extract";

const UA = "Mozilla/5.0 (compatible; AltoRank-Auditor/1.0; +https://altorank.co; site audit)";

/** Past this a body is cut; a 50,000-URL sitemap is about 10 MB, and the walk caps URLs long before. */
const MAX_BODY_CHARS = 12_000_000;

// ── The shared fetch ────────────────────────────────────────────────────────

export interface SiteFetchResult {
  /** 0 when nothing answered. */
  status: number;
  /** The body of a 2xx answer; null otherwise. */
  body: string | null;
  /** Where redirects ended. */
  finalUrl: string;
}

/** A GET, injectable so the walk can be tested against fixture bodies. */
export type SiteGet = (url: string, timeoutMs: number) => Promise<SiteFetchResult>;

interface SiteReadScope {
  bodies: Map<string, Promise<SiteFetchResult>>;
  /** Requests that actually left, for the log and the tests. */
  requests: number;
}

const scope = new AsyncLocalStorage<SiteReadScope>();

/**
 * Run `fn` with one shared cache of site files. Nested calls join the outer
 * scope. The onboarding run opens one around everything it does, so the
 * wizard's reader, the readiness check, the page crawl and the link pool
 * share a single read of each file.
 */
export function withSiteReads<T>(fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  return scope.run({ bodies: new Map(), requests: 0 }, fn);
}

/** Requests made inside the current scope; null outside one. */
export function siteReadRequests(): number | null {
  return scope.getStore()?.requests ?? null;
}

/**
 * Bodies already fetched by someone else (the readiness check's recorder),
 * offered to the current scope so nobody asks for them again. A URL already
 * in the scope keeps what it has.
 */
export function primeSiteReads(bodies: ReadonlyMap<string, string>): void {
  const s = scope.getStore();
  if (!s) return;
  for (const [url, body] of bodies) {
    if (!s.bodies.has(url)) s.bodies.set(url, Promise.resolve({ status: 200, body, finalUrl: url }));
  }
}

async function plainGet(url: string, timeoutMs: number): Promise<SiteFetchResult> {
  // A host that refused this run is not asked again (lib/audit/host-circuit.ts).
  if (refusing(url)) return { status: 403, body: null, finalUrl: url };
  try {
    const res = await fetchSite(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs), timeoutMs });
    if (!res.ok) {
      await res.text().catch(() => "");
      return { status: res.status, body: null, finalUrl: res.url || url };
    }
    return { status: res.status, body: (await res.text()).slice(0, MAX_BODY_CHARS), finalUrl: res.url || url };
  } catch {
    return { status: 0, body: null, finalUrl: url };
  }
}

/**
 * One GET of a site file, shared inside a `withSiteReads` scope: a second
 * caller, even one asking while the first request is still in flight, gets the
 * same answer without a second request.
 */
export function getSiteFile(url: string, timeoutMs: number = 10_000): Promise<SiteFetchResult> {
  const s = scope.getStore();
  if (!s) return plainGet(url, timeoutMs);
  const hit = s.bodies.get(url);
  if (hit) return hit;
  s.requests++;
  const pending = plainGet(url, timeoutMs);
  s.bodies.set(url, pending);
  // No answer at all (a timeout, a reset) is not the file's answer: a later
  // reader with more time left may ask again. Anything the host said - a 404,
  // a refusal - stands for the run.
  void pending.then((r) => {
    if (r.status === 0 && s.bodies.get(url) === pending) s.bodies.delete(url);
  });
  return pending;
}

/** `getSiteFile`'s body, or null. For callers that only want 2xx text. */
export async function siteFileBody(url: string, timeoutMs?: number): Promise<string | null> {
  return (await getSiteFile(url, timeoutMs)).body;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface SiteUrl {
  url: string;
  /** ISO, from the sitemap's `lastmod` or the feed's date; null when the site gave none. */
  lastmod: string | null;
  /** Listed by a sitemap or feed that holds only posts (`post-sitemap.xml`, `sitemap_blogs_1.xml`, an RSS feed). */
  fromPostList: boolean;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<(?:[a-z]+:)?${tag}\\b[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</(?:[a-z]+:)?${tag}>`, "i"));
  return m ? decodeEntities(m[1].trim()) : null;
}

export function looksLikeSitemap(body: string): boolean {
  return /<(urlset|sitemapindex)[\s>]/i.test(body.slice(0, 2000));
}

/**
 * The `<url>` (or, in an index, `<sitemap>`) entries of a sitemap, with their
 * `lastmod`. A sitemap written without the wrapping elements still yields its
 * `<loc>`s, with no dates.
 */
export function sitemapEntries(xml: string): Array<{ loc: string; lastmod: string | null }> {
  const blocks = [...xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  if (blocks.length) {
    return blocks
      .map((b) => ({ loc: tagText(b[2], "loc") ?? "", lastmod: isoOrNull(tagText(b[2], "lastmod")) }))
      .filter((e) => e.loc);
  }
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => ({ loc: decodeEntities(m[1]), lastmod: null }));
}

/** Is this sitemap an index of other sitemaps? Said by its root element, or by every entry being XML. */
export function isSitemapIndex(xml: string): boolean {
  if (/<sitemapindex[\s>]/i.test(xml.slice(0, 2000))) return true;
  const locs = sitemapEntries(xml).map((e) => e.loc);
  return locs.length > 0 && locs.every((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
}

/** RSS `<item>`s and Atom `<entry>`s: each post's link and date. */
export function feedEntries(xml: string): Array<{ loc: string; lastmod: string | null }> {
  const out: Array<{ loc: string; lastmod: string | null }> = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const loc = tagText(m[1], "link");
    if (loc) out.push({ loc, lastmod: isoOrNull(tagText(m[1], "pubDate") ?? tagText(m[1], "date")) });
  }
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const link =
      m[1].match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
      m[1].match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1];
    if (link) out.push({ loc: decodeEntities(link), lastmod: isoOrNull(tagText(m[1], "published") ?? tagText(m[1], "updated")) });
  }
  return out;
}

/**
 * The feeds a page declares in its head. WordPress, Ghost, Squarespace and
 * most hand-built blogs write one; it is the cheapest list of recent posts
 * a site without a sitemap has.
 */
export function feedLinksIn(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    // Comment feeds list comments, not posts.
    if (/comments/i.test(href)) continue;
    try {
      out.push(new URL(decodeEntities(href), base).toString());
    } catch { /* not a URL */ }
  }
  return [...new Set(out)];
}

// ── What is a post ──────────────────────────────────────────────────────────

/** A sitemap whose name says it lists posts: post-sitemap.xml, wp-sitemap-posts-post-1.xml, sitemap_blogs_1.xml, sitemap-articles.xml. */
const POST_LIST_NAME = /(^|[/_-])(posts?|blogs?|articles?|news|journal|magazine|stories)([/_.-]|$)|posts-post/;
/** Sitemaps of taxonomy, products and media: read last, never posts. */
const NON_POST_LIST = /(categor|tag|author|product|collection|image|video|attachment|format|media|taxonom|-tax|_tax)/;

function nameOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * How a child sitemap's name ranks: lists of posts first, then pages, then
 * everything else, and taxonomy, products and media last. A Shopify store's
 * index lists its products first, and three thousand of them filled the URL
 * cap before `sitemap_blogs_1.xml` was read.
 */
export function childRank(url: string): number {
  const name = nameOf(url);
  if (NON_POST_LIST.test(name)) return 3;
  if (POST_LIST_NAME.test(name)) return 0;
  if (/page/.test(name)) return 1;
  return 2;
}

export function isPostListName(url: string): boolean {
  return childRank(url) === 0;
}

/** Paths that are lists or chrome, never one post. */
const NOT_A_POST = /\/(tag|tags|category|categories|author|authors|page|feed|search|cart|checkout|account|wp-content|wp-json|cdn-cgi)(\/|$)/i;
/** One-segment pages every site has that a long slug can still look like. */
const SITE_PAGE = /^(privacy|terms|cookie|cookies|legal|imprint|impressum|contact|contatti|about|chi-siamo|pricing|prezzi|faq|careers|jobs|login|signup|sign-up|register|thank|grazie|404)/i;
const ASSET = /\.(xml|json|txt|rss|atom|pdf|jpe?g|png|gif|svg|webp|ico|css|js|zip|mp4|mp3)(\?|$)/i;
const LOCALE = /^[a-z]{2}(-[a-z]{2})?$/i;

/**
 * Does this URL look like one piece of writing? Evidence, strongest first:
 *
 *   it came from a list that holds only posts (a post sitemap, a feed)
 *   it sits under a blog folder with a slug of its own (/blog/x, /blogs/news/x, /magazine/x)
 *   it carries a date in its path (/2026/09/x)
 *   it is a one-segment slug of four words or more (/how-to-rank-in-2026/),
 *     which is what a WordPress post on the default permalink looks like and
 *     what almost no services page does
 *
 * Taxonomy, pagination, assets, the homepage and the blog index itself never are.
 */
export function looksLikePost(url: string, opts: { fromPostList?: boolean } = {}): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const segs = path.split("/").filter(Boolean);
  if (!segs.length || ASSET.test(path) || NOT_A_POST.test(path)) return false;
  const last = segs[segs.length - 1];
  // The folder itself (/blog, /blogs/news, /blog/de) is an index, not a post.
  if (POST_SEGMENTS.test(`/${last}/`) || (segs.length > 1 && LOCALE.test(last))) return false;
  // A post list is trusted for every slug but the pages every site has: a
  // pricing page listed in a post sitemap is a misfiled pricing page.
  const sitePage = segs.length === 1 && SITE_PAGE.test(last);
  if (opts.fromPostList) return !sitePage;
  if (POST_SEGMENTS.test(`${path.replace(/\/?$/, "/")}`)) {
    // Shopify's /blogs/<handle> is the index for that handle.
    return !(/^blogs$/i.test(segs[0]) && segs.length === 2);
  }
  if (/\/\d{4}\/\d{2}\//.test(path)) return true;
  return segs.length === 1 && !sitePage && last.split(/[-_]/).filter(Boolean).length >= 4;
}

/**
 * Posts first, newest first; then everything else in the order the site
 * listed it. Undated posts keep the site's order after the dated ones: a
 * WordPress post sitemap lists oldest first, so a date is the only honest way
 * to find the newest, and a list with none is left as it came.
 */
export function prioritiseSiteUrls(entries: SiteUrl[], max: number): SiteUrl[] {
  const posts: SiteUrl[] = [];
  const rest: SiteUrl[] = [];
  for (const e of entries) (looksLikePost(e.url, { fromPostList: e.fromPostList }) ? posts : rest).push(e);
  const dated = posts.filter((p) => p.lastmod).sort((a, b) => b.lastmod!.localeCompare(a.lastmod!));
  const undated = posts.filter((p) => !p.lastmod);
  return [...dated, ...undated, ...rest].slice(0, max);
}

// ── The walk ────────────────────────────────────────────────────────────────

export interface SiteUrlRead {
  urls: SiteUrl[];
  /** Where the list came from. */
  source: "sitemap" | "feed" | "blog_index" | "none";
  /** The sitemap that answered, when one did. */
  sitemapUrl: string | null;
  /** The blog index the fallback read, when it did. */
  blogRootUrl: string | null;
  /** True when the clock or a cap stopped the walk short. */
  truncated: boolean;
}

export interface ReadSiteUrlsOptions {
  timeoutMs?: number;
  maxUrls?: number;
  /** Child sitemaps followed across every index, in total. */
  maxChildren?: number;
  /** Sitemaps robots.txt declares, when the caller already read it. */
  declaredSitemaps?: string[];
  /** Start here rather than at robots.txt and the conventional paths. */
  sitemaps?: string[];
  /** Bodies the caller already holds, by URL. */
  bodies?: ReadonlyMap<string, string>;
  /** Wall-clock stop, in `Date.now()` terms. */
  deadline?: number;
  /** Read the feed and blog index when there is no sitemap. On by default. */
  fallback?: boolean;
  get?: SiteGet;
}

const CANDIDATES = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/wp-sitemap.xml"];
/** Index pages read past the first, on a blog with no sitemap and no feed. */
const BLOG_PAGES_PAST_FIRST = 2;

/**
 * Every URL the site declares, with dates where it gave them.
 *
 * Polite by construction: robots.txt once, then the first conventional
 * sitemap path that answers (not all of them), at most `maxChildren` child
 * sitemaps, and on a site with no sitemap at most five more requests. Inside
 * `withSiteReads` each of those is shared with every other reader.
 *
 * Never throws. Out of time returns what was found, with `truncated`.
 */
export async function readSiteUrls(domain: string, opts: ReadSiteUrlsOptions = {}): Promise<SiteUrlRead> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxUrls = opts.maxUrls ?? 5_000;
  const maxChildren = opts.maxChildren ?? 20;
  const origin = (domain.startsWith("http") ? new URL(domain).origin : `https://${domain.replace(/\/+$/, "")}`);
  const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
  const fetchOne = opts.get ?? getSiteFile;
  const body = async (url: string): Promise<string | null> => {
    const held = opts.bodies?.get(url);
    if (held !== undefined) return held;
    try {
      return (await fetchOne(url, timeoutMs)).body;
    } catch {
      return null;
    }
  };

  const result: SiteUrlRead = { urls: [], source: "none", sitemapUrl: null, blogRootUrl: null, truncated: false };
  const seen = new Map<string, SiteUrl>();
  const add = (loc: string, lastmod: string | null, fromPostList: boolean) => {
    let url: string;
    try {
      url = new URL(loc, origin).toString();
    } catch {
      return;
    }
    if (ASSET.test(url)) return;
    const had = seen.get(url);
    if (had) {
      had.fromPostList ||= fromPostList;
      had.lastmod ??= lastmod;
      return;
    }
    if (seen.size >= maxUrls) {
      result.truncated = true;
      return;
    }
    seen.set(url, { url, lastmod, fromPostList });
  };

  // 1. Where the sitemaps are.
  let roots: string[];
  let probing = false;
  if (opts.sitemaps?.length) {
    roots = opts.sitemaps.slice(0, 3);
  } else {
    const declared = [...(opts.declaredSitemaps ?? [])];
    if (!opts.declaredSitemaps && !outOfTime()) {
      for (const line of ((await body(`${origin}/robots.txt`)) ?? "").split("\n")) {
        const m = line.match(/^\s*sitemap:\s*(\S+)/i);
        if (!m) continue;
        try {
          declared.push(new URL(m[1].trim(), origin).toString());
        } catch { /* not a URL */ }
      }
    }
    probing = declared.length === 0;
    roots = probing ? CANDIDATES.map((p) => origin + p) : [...new Set(declared)].slice(0, 3);
  }

  // 2. The sitemaps, indexes of indexes included, post lists first.
  let childrenLeft = maxChildren;
  const walk = async (url: string, depth: number, fromPostList: boolean): Promise<boolean> => {
    if (outOfTime()) {
      result.truncated = true;
      return false;
    }
    const xml = await body(url);
    if (!xml || !looksLikeSitemap(xml)) return false;
    result.sitemapUrl ??= url;
    if (!isSitemapIndex(xml)) {
      for (const e of sitemapEntries(xml)) add(e.loc, e.lastmod, fromPostList);
      return true;
    }
    if (depth >= 2) return true;
    const children = sitemapEntries(xml)
      .map((e, i) => ({ ...e, i, rank: childRank(e.loc) }))
      // Post lists first, then the newest, then the index's own order.
      .sort((a, b) => a.rank - b.rank || (b.lastmod ?? "").localeCompare(a.lastmod ?? "") || a.i - b.i);
    for (const child of children) {
      if (childrenLeft <= 0 || seen.size >= maxUrls || outOfTime()) {
        result.truncated = true;
        break;
      }
      childrenLeft--;
      await walk(child.loc, depth + 1, fromPostList || isPostListName(child.loc));
    }
    return true;
  };
  for (const root of roots) {
    if (seen.size >= maxUrls) break;
    const answered = await walk(root, 0, isPostListName(root));
    // Probing conventional paths: the first that answers is the sitemap. The
    // rest are usually the same file under another name, and every probe is
    // one more request against a host that may be counting.
    if (answered && probing) break;
  }
  if (seen.size || result.sitemapUrl) {
    result.source = result.sitemapUrl ? "sitemap" : "none";
    result.urls = [...seen.values()];
    return result;
  }
  if (opts.fallback === false || opts.sitemaps?.length || outOfTime()) {
    result.truncated ||= outOfTime();
    return result;
  }

  // 3. No sitemap: the feed the homepage declares.
  const home = await body(`${origin}/`);
  for (const feed of home ? feedLinksIn(home, origin).slice(0, 1) : []) {
    const xml = await body(feed);
    if (xml) for (const e of feedEntries(xml)) if (sameSite(e.loc, origin)) add(e.loc, e.lastmod, true);
  }
  if (seen.size) {
    result.source = "feed";
    result.urls = [...seen.values()];
    return result;
  }

  // 4. Nor a feed: the blog index the homepage links to, and its next pages.
  const linked = home ? blogRootLinkedFrom(home, origin) : null;
  const start = linked ?? `${origin}/blog/`;
  let page: string | null = start;
  for (let n = 0; page && n <= BLOG_PAGES_PAST_FIRST && !outOfTime(); n++) {
    const html = await body(page);
    if (!html) break;
    if (n === 0) result.blogRootUrl = start;
    for (const u of postLinksOnIndex(html, start)) add(u, null, false);
    page = nextPageOf(html, page);
  }
  if (seen.size) result.source = "blog_index";
  result.urls = [...seen.values()];
  return result;
}

function sameSite(url: string, origin: string): boolean {
  try {
    return new URL(url).host.replace(/^www\./, "") === new URL(origin).host.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)].map((m) => decodeEntities(m[1]));
}

/** The homepage's link to its blog, when it has one under a known name. */
function blogRootLinkedFrom(html: string, origin: string): string | null {
  for (const href of hrefs(html)) {
    try {
      const u = new URL(href, origin);
      if (!sameSite(u.toString(), origin)) continue;
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length === 1 && POST_SEGMENTS.test(`/${segs[0]}/`)) return `${u.origin}/${segs[0]}/`;
    } catch { /* not a URL */ }
  }
  return null;
}

/** Links on a blog index that point at pages under it. */
export function postLinksOnIndex(html: string, indexUrl: string): string[] {
  let root: URL;
  try {
    root = new URL(indexUrl);
  } catch {
    return [];
  }
  const rootPath = root.pathname.replace(/\/page\/\d+\/?$/, "").replace(/\/+$/, "");
  const out = new Set<string>();
  for (const href of hrefs(html)) {
    let u: URL;
    try {
      u = new URL(href, root);
    } catch {
      continue;
    }
    if (u.host !== root.host) continue;
    u.search = "";
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    if (!path.startsWith(`${rootPath}/`) || NOT_A_POST.test(path) || ASSET.test(path)) continue;
    out.add(u.toString());
  }
  return [...out];
}

/** The next page of a paginated index: `rel="next"`, or a /page/N+1 link. */
export function nextPageOf(html: string, current: string): string | null {
  const rel =
    html.match(/<(?:link|a)\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
    html.match(/<(?:link|a)\b[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i)?.[1];
  try {
    if (rel) return new URL(decodeEntities(rel), current).toString();
    const n = Number(current.match(/\/page\/(\d+)\/?$/)?.[1] ?? 1) + 1;
    const want = `/page/${n}`;
    for (const href of hrefs(html)) {
      const u = new URL(href, current);
      if (u.pathname.replace(/\/+$/, "").endsWith(want)) return u.toString();
    }
  } catch { /* not a URL */ }
  return null;
}
