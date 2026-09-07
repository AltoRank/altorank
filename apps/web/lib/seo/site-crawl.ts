// ---------------------------------------------------------------------------
// The pages a site already has
// ---------------------------------------------------------------------------
//
// Everything AltoRank knew about a customer's content, it had written itself.
// A site arriving with 204 published posts looked empty: the internal-link
// resolver found no targets, the first look scored hygiene across whatever the
// homepage linked to, and the refresh queue could only see our own drafts.
//
// This reads their sitemap, fetches each page, extracts the body, and scores
// it with the same three scorers a generated draft gets. Two deliberate
// choices:
//
//   Sitemap, not a crawl. domain-analysis walks links breadth-first to depth 2
//   and on fitsuite.co reached 2 of 204 posts, because a paginated blog index
//   hides everything past the first page. A sitemap is the site telling us
//   what it has.
//
//   Our own fetch, not the On-Page API. Both were measured on 2026-09-04.
//   `content_parsing` returns clean text blocks and costs $0.00015 a page, but
//   it returns TEXT: the anchors are gone, and links are the whole point here.
//   A plain GET plus `extractMainContent` returned `source=main`,
//   `heuristic=false` and all 31 anchors intact, for nothing. The fetch is
//   isolated in `fetchPage` so a JavaScript-rendered site can be switched to
//   On-Page's rendering later without touching anything else.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { extractMainContent } from "@/lib/audit/markdown";
import { decodeEntities } from "@/lib/audit/html-utils";
import { collectJsonLdTypes } from "@/lib/audit/agent-readiness";
import { scoreArticle } from "./scoring";
import { scoreCitationReadiness } from "./aeo-scoring";
import { auditArticle } from "./article-audit";
import { extractLinks } from "./links";
import { groupByPage, type RankedKeyword } from "./ranked-keywords";
import { fetchInstantPage, type OnPageFacts } from "@/lib/audit/onpage";
import { hasDataForSEOCredentials } from "./client";
import { ALLOW_EVERYTHING, isAllowed, loadRobots, type RobotsRules } from "./robots";
import {
  canonicalOf,
  checkPage,
  countH1,
  countImages,
  duplicateFindings,
  openGraphOf,
  robotsDirectivesOf,
  summarise,
  type RedirectHop,
  type TechFacts,
  type TechFinding,
  type TechSummary,
} from "./tech-audit";

const SITE_PAGES_UPSERT_CHUNK = 10;

/** The crawl read the site but could not store (all of) it. */
export class SitePagesWriteError extends Error {
  constructor(message: string, public readonly storedBefore: number) {
    super(message);
    this.name = "SitePagesWriteError";
  }
}

const UA =
  "Mozilla/5.0 (compatible; AltoRank-Auditor/1.0; +https://altorank.co; site audit)";

/**
 * Below this a fetched page has no readable body: almost always a shell whose
 * content arrives from JavaScript. A genuinely thin page exists, but scoring
 * one on fifty words says nothing either.
 */
const MIN_WORDS = 60;

/** Bounds, so one site cannot become an hour of fetching. */
export const DEFAULTS = {
  maxPages: 200,
  concurrency: 4,
  timeoutMs: 15_000,
  /** Skip a page whose body is byte-identical to the stored one. */
  skipUnchanged: true,
  /**
   * The whole crawl, wall-clock. Nothing enforced this before: the caller was
   * a cron with 300 seconds to itself and a page cap that fitted inside it.
   * Onboarding shares its 300 seconds with keyword discovery and cannot, so
   * the crawl needs a stop it applies to itself. Whatever has been read when
   * the budget runs out is stored; the rest is left for the nightly cron,
   * which is self-healing by `last_pages_crawl_at`.
   */
  budgetMs: 240_000,
  /** Hops the crawler will follow before giving up on a URL. */
  maxRedirects: 5,
};

/** How the crawler names itself, everywhere. Also the name robots.txt matches. */
export const CRAWLER_NAME = "AltoRank-Auditor";

/** Path segments that name a blog. Same list `lib/cms/blog-url.ts` reasons over. */
const POST_SEGMENTS = /\/(blog|posts?|articles?|news|insights|stories|guide|guida|guides)\//i;

/**
 * Schema types that say "this page is a piece of writing". A page that
 * declares one is an article whatever its URL looks like.
 */
const ARTICLE_SCHEMA = /^(Article|BlogPosting|NewsArticle|TechArticle|Report|ScholarlyArticle)$/i;

/** Two-letter locale segments, so /blog/de reads as a section, not a post. */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/** Pages that are never content: feeds, assets, and the index pages themselves. */
const NOT_CONTENT =
  /\.(xml|json|txt|rss|atom|pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|zip)(\?|$)/i;

export type PageType = "article" | "listing" | "page";

export interface SitePage {
  url: string;
  path: string;
  page_type: PageType;
  content_hash: string | null;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  word_count: number | null;
  keyword: string | null;
  keyword_source: "ranked" | "heading" | null;
  position: number | null;
  seo_score: number | null;
  seo_checks: unknown;
  aeo_score: number | null;
  aeo_checks: unknown;
  audit: unknown;
  internal_links: number | null;
  external_links: number | null;
  published_at: string | null;
  modified_at: string | null;
  schema_types: string[] | null;
  status: number;
  error: string | null;
  /**
   * Set when our own fetch read nothing and DataForSEO's browser was used
   * instead. Those pages have facts but no scores: the API returns counts and
   * checks, not markup, and the scorers need to see headings and anchors.
   */
  rendered_by?: "dataforseo" | null;
  /** DataForSEO's own 0-100 score, only on a rendered page. */
  onpage_score?: number | null;
  /**
   * What is mechanically wrong with the page (migration 078). Null means
   * nobody has checked; `[]` means checked and clean, and the two must stay
   * distinguishable or an unchecked site reads as a perfect one.
   */
  tech_findings?: TechFinding[] | null;
  /** `tech_findings.length`, so the dashboard can sort and count in SQL. */
  tech_issue_count?: number | null;
  tech_checked_at?: string | null;
}

export interface CrawlSummary {
  discovered: number;
  fetched: number;
  failed: number;
  skipped: number;
  pages: SitePage[];
  /**
   * The technical assessment over the pages this run read, or null when the
   * crawl was not asked for one.
   */
  tech: TechSummary | null;
  /** URLs robots.txt told us not to fetch. Not failures: we did not ask. */
  disallowed: number;
  /** True when the budget or the page cap stopped the crawl short. */
  truncated: boolean;
  /** Set when robots.txt itself refused us the site. */
  robotsBlocked: boolean;
}

// ── Discovery ───────────────────────────────────────────────────────────────

async function bodyOf(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetchSite(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function locsIn(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    decodeEntities(m[1]),
  );
}

/**
 * Every page URL the site declares, from robots.txt to sitemap to sitemap
 * index. One level of index nesting, which is all anyone uses.
 *
 * `deadline` is a wall-clock stop, in `Date.now()` terms, and it is not
 * optional in practice: this walk is sequential and every fetch in it is
 * bounded only by `timeoutMs`. One Yoast-style `sitemap_index.xml` on a slow
 * host is up to 20 child sitemaps at 10 s each, times up to three roots -
 * about 210 seconds before a single page has been fetched. `syncSitePages`
 * used to compute its budget and then consult it only inside the page loop,
 * so all of that ran outside it, on an onboarding worker with 300 seconds
 * that had already spent 61-174 s in `analyseDomain`. Past 300 s Vercel kills
 * the invocation, the `onboarding_runs` row stays `running`, and the progress
 * screen polls forever - the exact failure the poll-based rewrite removed.
 *
 * Out of time returns what has been found so far rather than throwing: a
 * partial sitemap is a partial crawl, which is the outcome the page loop's
 * own deadline already produces and which `truncated` already describes. The
 * nightly cron/site-pages picks up the rest.
 */
export async function discoverUrls(
  domain: string,
  opts: { timeoutMs?: number; maxUrls?: number; declaredSitemaps?: string[]; deadline?: number } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxUrls = opts.maxUrls ?? 5000;
  const origin = domain.startsWith("http") ? domain : `https://${domain}`;
  const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline;

  // The caller may already hold robots.txt (syncSitePages reads it for its
  // Disallow rules), and its Sitemap lines come with it, so the file is not
  // fetched a second time.
  const declared: string[] = [...(opts.declaredSitemaps ?? [])];
  if (!opts.declaredSitemaps) {
    if (outOfTime()) return [];
    const robots = await bodyOf(`${origin}/robots.txt`, timeoutMs);
    for (const line of (robots ?? "").split("\n")) {
      const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
      if (m) declared.push(m[1].trim());
    }
  }
  const roots = declared.length
    ? declared.slice(0, 3)
    : [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap_index.xml`];

  const urls = new Set<string>();
  for (const root of roots) {
    if (outOfTime()) break;
    const body = await bodyOf(root, timeoutMs);
    if (!body) continue;
    const locs = locsIn(body);
    const nested = locs.filter((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
    // An index lists sitemaps; a sitemap lists pages. All-XML means index.
    if (nested.length && nested.length === locs.length) {
      for (const child of nested.slice(0, 20)) {
        // Checked before the fetch, not after: the point is not to start one.
        if (outOfTime()) break;
        const childBody = await bodyOf(child, timeoutMs);
        if (childBody) for (const u of locsIn(childBody)) urls.add(u);
        if (urls.size >= maxUrls) break;
      }
    } else {
      for (const u of locs) urls.add(u);
    }
    if (urls.size >= maxUrls) break;
  }

  return [...urls].filter((u) => !NOT_CONTENT.test(u)).slice(0, maxUrls);
}

/**
 * Posts first, then everything else.
 *
 * A blog post is what a draft wants to link to and what the refresh queue is
 * about; a pricing page is a valid link target but rarely the interesting one.
 * When the cap bites, it should bite the marketing pages.
 */
export function prioritise(urls: string[], maxPages: number): string[] {
  const posts = urls.filter((u) => POST_SEGMENTS.test(u));
  const rest = urls.filter((u) => !POST_SEGMENTS.test(u));
  return [...posts, ...rest].slice(0, maxPages);
}

// ── One page ────────────────────────────────────────────────────────────────

function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']|` +
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
      "i",
    );
    const m = html.match(re);
    const v = (m?.[1] ?? m?.[2] ?? "").trim();
    if (v) return decodeEntities(v);
  }
  return null;
}

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function textOf(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const t = decodeEntities(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return t || null;
}

/**
 * Function words, in the languages this product writes. Dropped from a guessed
 * keyword because nobody searches them and they push the real terms past the
 * length cap.
 */
const STOPWORDS = new Set([
  // en
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "with", "your",
  "how", "what", "why", "best", "guide", "vs",
  // it
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della",
  "dei", "delle", "per", "con", "da", "in", "su", "e", "o", "che", "come",
  "quali", "cosa", "migliori", "guida", "tuo", "tua",
  // es / fr / de, lightly
  "el", "los", "las", "de", "para", "con", "y", "les", "des", "pour", "avec",
  "der", "die", "das", "und", "fur", "mit",
]);

/**
 * The term a page appears to target, when the SERP has not told us.
 *
 * From the slug rather than the H1. A slug is already the keyword, written by
 * whoever published the page: "app-personal-trainer". An H1 is a headline,
 * "Le 5 Funzionalità Essenziali di un'App per Personal Trainer", and scoring
 * against that made three checks unpassable by construction - a full headline
 * will not appear inside its own H2, its own opening sentence, or a 155-char
 * meta description. Measured on fitsuite.co 2026-09-04: 38 of 40 pages
 * "failed" the meta-description check purely because of this.
 *
 * Three words, not five. A slug is often the whole descriptive title
 * ("coaching-powerlifting-programmazione-federazione") and a real target term
 * is two or three words; the extra words only make an exact-match test less
 * likely to mean anything.
 *
 * The H1 remains the fallback for a page whose slug carries no words, like a
 * dated or numeric permalink.
 */
export function keywordForPage(
  path: string,
  h1: string | null,
  domain: string,
): string | null {
  const brand = new Set(
    domain.toLowerCase().replace(/^www\./, "").split(".")[0].split(/[-_]/),
  );
  const usable = (words: string[]) =>
    words
      .filter((w) => w.length > 1 && !brand.has(w) && !STOPWORDS.has(w) && !/^\d+$/.test(w))
      .slice(0, 3);

  const slugWords = usable(
    (path.split("/").filter(Boolean).pop() ?? "")
      .toLowerCase()
      .replace(/\.(html?|php|aspx?)$/, "")
      .split(/[-_]+/),
  );
  if (slugWords.length >= 2) return slugWords.join(" ");

  if (!h1) return slugWords.length ? slugWords.join(" ") : null;
  const headWords = usable(
    h1
      .toLowerCase()
      .replace(/[|–—:].*$/, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/),
  );
  return headWords.length ? headWords.join(" ") : null;
}

/**
 * What kind of page this is.
 *
 * The question that matters is "is this a piece of writing, or the index that
 * lists the writing", because only the first can be scored or linked to
 * meaningfully. Three signals, in order of how much they know:
 *
 *   1. the page's own schema. Article/BlogPosting is the site saying so.
 *   2. a published date. Indexes do not have one; posts almost always do.
 *   3. the shape of the path. A last segment that is a section name
 *      ("/blog"), a locale ("/blog/de") or a page number ("/blog/page/2") is
 *      an index. Anything with a slug on the end is not.
 *
 * Defaults to "page" rather than "article": a pricing page is not writing
 * either, and scoring it against a guessed keyword produces the same
 * unactionable noise the indexes did.
 */
export function classifyPageType(
  path: string,
  opts: { schemaTypes?: string[] | null; publishedAt?: string | null } = {},
): PageType {
  if ((opts.schemaTypes ?? []).some((t) => ARTICLE_SCHEMA.test(t))) return "article";

  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const isSectionRoot =
    segments.length === 0 ||
    POST_SEGMENTS.test(`/${last}/`) ||
    LOCALE_SEGMENT.test(last) ||
    /^\d+$/.test(last) ||
    last === "page";
  if (isSectionRoot) return "listing";

  if (opts.publishedAt) return "article";
  // Under a blog directory with a slug of its own: a post whose markup simply
  // says nothing about itself.
  return POST_SEGMENTS.test(path) ? "article" : "page";
}

/** One response, plus how many hops it took to get there. */
interface FetchedPage {
  status: number;
  finalUrl: string;
  redirects: RedirectHop[];
  headers: Record<string, string>;
  body: string;
  tlsUnverified: boolean;
}

/**
 * Fetch a page, following redirects by hand.
 *
 * `fetch()` follows them itself and reports only `redirected: boolean`, which
 * cannot tell "your sitemap lists the http:// URL" from "four hops through a
 * legacy path structure" - and those are different findings with different
 * fixes. So: `redirect: "manual"`, one hop at a time, each hop re-entering
 * `fetchSite` and therefore re-running `assertPublicUrl`, which is what stops
 * a public site from bouncing the crawler onto a private address.
 *
 * The TLS-lenient fallback inside `fetchSite` follows redirects internally, so
 * a page read that way reports no hops. That is stated rather than guessed:
 * `tlsUnverified` is on the result and is a finding of its own.
 */
async function fetchChain(
  url: string,
  opts: { timeoutMs: number; maxRedirects?: number },
): Promise<FetchedPage> {
  const max = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const redirects: RedirectHop[] = [];
  let current = url;

  for (let hop = 0; ; hop++) {
    const res = await fetchSite(current, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && hop < max) {
      const next = new URL(location, current).toString();
      redirects.push({ status: res.status, from: current, to: next });
      // Read and discard the body so the socket is released before the next hop.
      await res.text().catch(() => "");
      current = next;
      continue;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return {
      status: res.status,
      finalUrl: current,
      redirects,
      headers,
      body: res.ok && (headers["content-type"] ?? "").includes("text/html") ? await res.text() : "",
      tlsUnverified: headers["x-altorank-tls-unverified"] === "1",
    };
  }
}

export interface PageContext {
  domain: string;
  /**
   * Pay for a browser when our own fetch returns nothing usable.
   *
   * Off by default and deliberately so: rendering costs $0.0051 a page
   * against $0.00015 unrendered and nothing for a plain GET, so 204 pages
   * would be $1.04 instead of free. It earns that only on a site we cannot
   * read at all, where the alternative is an empty first look.
   */
  renderFallback?: boolean;
  /** Best-positioned ranked keyword per pathname, when the SERP told us. */
  rankedByPath?: Map<string, { keyword: string; position: number | null }>;
  timeoutMs?: number;
  /**
   * Run the technical checks and store their findings on the row. Off by
   * default so nothing that already calls `crawlPage` changes shape without
   * asking; `syncSitePages` turns it on for the assessment.
   */
  techChecks?: boolean;
}

/** Fetch one page, extract its body, and score it. Never throws. */
export async function crawlPage(url: string, ctx: PageContext): Promise<SitePage> {
  const path = (() => {
    try {
      return new URL(url).pathname.replace(/\/$/, "") || "/";
    } catch {
      return url;
    }
  })();

  const base: SitePage = {
    url, path, page_type: classifyPageType(path), content_hash: null, title: null, meta_description: null, h1: null,
    word_count: null, keyword: null, keyword_source: null, position: null,
    seo_score: null, seo_checks: null, aeo_score: null, aeo_checks: null, audit: null,
    internal_links: null, external_links: null, published_at: null, modified_at: null,
    schema_types: null, status: 0, error: null,
  };

  // A page nothing could be established about still carries the one finding
  // that can be: it did not load. The checks refuse to say more (see
  // `checkPage`), so a 404 reports as a 404 rather than as five missing tags.
  const failure = (status: number, error: string): SitePage =>
    ctx.techChecks
      ? {
          ...base,
          status,
          error,
          tech_findings: checkPage(emptyFacts(url, path, status)),
          tech_issue_count: 1,
          tech_checked_at: new Date().toISOString(),
        }
      : { ...base, status, error };

  let fetched: FetchedPage;
  try {
    fetched = await fetchChain(url, { timeoutMs: ctx.timeoutMs ?? DEFAULTS.timeoutMs });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; message?: string };
    return failure(
      0,
      e?.name === "TimeoutError" || e?.name === "AbortError"
        ? "timed out"
        : e?.cause?.code ?? e?.message ?? "fetch failed",
    );
  }
  const status = fetched.status;
  if (status < 200 || status >= 400) return failure(status, `HTTP ${status}`);
  if (!(fetched.headers["content-type"] ?? "").includes("text/html")) {
    return { ...base, status, error: "not HTML" };
  }
  const html = fetched.body;

  // `main` or the longest `article`, falling back to body-minus-chrome. The
  // whole page would score the nav and footer as part of the article.
  const main = extractMainContent(html);
  const body = main.html;

  // A client-rendered page returns its shell: a valid 200 with no words in it.
  // That is the one case worth paying a browser for, and only if the caller
  // has opted in.
  const words = body.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS && ctx.renderFallback && hasDataForSEOCredentials()) {
    const rendered = await renderPage(url, path, ctx);
    if (rendered) return rendered;
  }

  const title = metaContent(html, ["og:title"]) ?? textOf(html, "title");
  const h1 = textOf(body, "h1") ?? textOf(html, "h1");
  const metaDescription = metaContent(html, ["description", "og:description"]);

  const schemaTypes = collectJsonLdTypes(html);
  const publishedAt = isoOrNull(metaContent(html, ["article:published_time", "datePublished"]));
  const pageType = classifyPageType(path, { schemaTypes, publishedAt });

  const ranked = ctx.rankedByPath?.get(path);
  // Only writing gets a keyword. An index has no term it is trying to win,
  // and giving it one ("blog") produced a scored page nobody could act on.
  const keyword = pageType === "article" ? ranked?.keyword ?? keywordForPage(path, h1, ctx.domain) : null;
  const keywordSource: SitePage["keyword_source"] = !keyword
    ? null
    : ranked
      ? "ranked"
      : "heading";

  const links = extractLinks(body, ctx.domain);

  // Scoring needs a keyword. With none, store the page as a link target and
  // leave the scores null rather than scoring against an empty string, which
  // would read as a measured zero.
  const seo = keyword ? scoreArticle(body, keyword, { siteDomain: ctx.domain, metaDescription, title }) : null;
  const aeo = keyword ? scoreCitationReadiness(body, keyword, { siteDomain: ctx.domain }) : null;
  const audit = keyword
    ? auditArticle({
        html: body, keyword, siteDomain: ctx.domain, title, metaDescription,
        slug: path.split("/").filter(Boolean).pop() ?? "",
        keywordConfidence: keywordSource === "ranked" ? "known" : "guessed",
        // A published page's hero is in the template, not the body, so the
        // featured-image check would fail every page for a reason nobody can
        // act on from here.
        featuredImageUrl: metaContent(html, ["og:image"]),
      })
    : null;

  const internalLinks = links.filter((l) => l.kind === "internal").length;
  const externalLinks = links.filter((l) => l.kind === "external").length;

  // The technical read. Everything below comes out of the response already in
  // hand - no second fetch, no API - and none of it is an opinion about the
  // writing: counts, lengths, presence, and what the page tells crawlers.
  // `images` and `h1Count` are taken over the whole document rather than the
  // extracted body, because a hero image in the template with no alt is still
  // an image on the page with no alt, and a second H1 in the header is exactly
  // the ambiguity the check is about.
  let techFindings: TechFinding[] | null = null;
  if (ctx.techChecks) {
    const imgs = countImages(html);
    const facts: TechFacts = {
      url,
      finalUrl: fetched.finalUrl,
      status,
      redirects: fetched.redirects,
      tlsUnverified: fetched.tlsUnverified,
      pageType,
      title,
      metaDescription,
      h1Count: countH1(html),
      wordCount: words,
      canonical: canonicalOf(html, fetched.finalUrl),
      robotsDirectives: robotsDirectivesOf(html, fetched.headers),
      images: imgs.total,
      imagesMissingAlt: imgs.missingAlt,
      internalLinks,
      externalLinks,
      jsonLdTypes: schemaTypes,
      openGraph: openGraphOf(html),
    };
    techFindings = checkPage(facts);
  }

  return {
    url, path, page_type: pageType,
    content_hash: createHash("sha256").update(body).digest("hex").slice(0, 32),
    title, meta_description: metaDescription, h1,
    word_count: words,
    keyword, keyword_source: keywordSource, position: ranked?.position ?? null,
    seo_score: seo?.score ?? null, seo_checks: seo?.checks ?? null,
    aeo_score: aeo?.score ?? null, aeo_checks: aeo?.checks ?? null,
    audit: audit ? { verdict: audit.verdict, counts: audit.counts, items: audit.items } : null,
    internal_links: internalLinks,
    external_links: externalLinks,
    published_at: publishedAt,
    modified_at: isoOrNull(metaContent(html, ["article:modified_time", "dateModified"])),
    schema_types: schemaTypes,
    status, error: null,
    ...(techFindings
      ? {
          tech_findings: techFindings,
          tech_issue_count: techFindings.length,
          tech_checked_at: new Date().toISOString(),
        }
      : {}),
  };
}

/** The facts of a page that never answered: enough for the one honest finding. */
function emptyFacts(url: string, path: string, status: number): TechFacts {
  return {
    url,
    finalUrl: url,
    status,
    redirects: [],
    tlsUnverified: false,
    pageType: classifyPageType(path),
    title: null,
    metaDescription: null,
    h1Count: 0,
    wordCount: 0,
    canonical: null,
    robotsDirectives: [],
    images: 0,
    imagesMissingAlt: 0,
    internalLinks: 0,
    externalLinks: 0,
    jsonLdTypes: [],
    openGraph: [],
  };
}

// ── The whole site ──────────────────────────────────────────────────────────

export interface SyncOptions {
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  skipUnchanged?: boolean;
  /** Only URLs matching this substring, for a targeted re-crawl. */
  only?: string;
  onProgress?: (done: number, total: number) => void;
  /**
   * Run the technical checks and store their findings. The crawl is the same
   * either way - same fetches, same parse - so this only decides whether the
   * findings are computed and written.
   */
  techChecks?: boolean;
  /** Wall-clock stop for the whole crawl. See `DEFAULTS.budgetMs`. */
  budgetMs?: number;
  /**
   * Obey robots.txt. On by default and there is no good reason to turn it off
   * outside a test: this crawler visits sites that never asked for it, and a
   * `Disallow` is the one instruction they can leave.
   */
  respectRobots?: boolean;
}

/**
 * Discover, fetch, score and store every page of a site.
 *
 * Ranked keywords come from the workspace's last domain analysis rather than a
 * fresh lookup: that call was already paid for, and re-fetching would make a
 * free crawl cost money.
 */
export async function syncSitePages(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
  opts: SyncOptions = {},
): Promise<CrawlSummary> {
  const maxPages = opts.maxPages ?? DEFAULTS.maxPages;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
  const skipUnchanged = opts.skipUnchanged ?? DEFAULTS.skipUnchanged;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULTS.budgetMs);
  const techChecks = opts.techChecks ?? false;

  // Ask permission before reading anything. `loadRobots` is handed the same
  // guarded fetch every other request here uses, so a robots.txt on a private
  // address is refused before it leaves.
  const origin = domain.startsWith("http") ? domain : `https://${domain}`;
  const robots: RobotsRules =
    opts.respectRobots === false
      ? ALLOW_EVERYTHING
      : await loadRobots(origin, CRAWLER_NAME, async (u) => {
          const body = await bodyOf(u, timeoutMs);
          // `bodyOf` swallows the status, which is exactly what the RFC's
          // 4xx/5xx split needs to see. Re-read it here rather than widening
          // `bodyOf`, whose other two callers do not care.
          if (body !== null) return { status: 200, body };
          try {
            const res = await fetchSite(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
            return { status: res.status, body: null };
          } catch {
            return { status: 0, body: null };
          }
        });

  const all = await discoverUrls(domain, {
    timeoutMs: opts.timeoutMs,
    declaredSitemaps: robots.source === "fetched" ? robots.sitemaps : undefined,
    // The same budget the page loop below obeys. Discovery is the half that
    // runs first and used not to have it: see discoverUrls.
    deadline,
  });
  // Whether the sitemap walk gave up early. Recorded here rather than inferred
  // later, because a discovery that stopped at 8 of 400 URLs then fetches all
  // 8 and would otherwise report a complete crawl of an eight-page site.
  const discoveryTruncated = Date.now() >= deadline;
  const filtered = opts.only ? all.filter((u) => u.includes(opts.only!)) : all;
  const allowed = filtered.filter((u) => isAllowed(robots, u));
  const disallowed = filtered.length - allowed.length;
  // Everything refused, and there were URLs to refuse: the site said no.
  const robotsBlocked = filtered.length > 0 && allowed.length === 0;
  const urls = prioritise(allowed, maxPages);

  // A `Crawl-delay` is the site asking for space between requests. Honour it
  // by dropping to one worker and pausing, rather than by ignoring it because
  // it is not in the RFC: it is what the site owner wrote down.
  const crawlDelayMs = Math.min((robots.crawlDelaySeconds ?? 0) * 1000, 5_000);
  const workers = crawlDelayMs > 0 ? 1 : concurrency;

  const rankedByPath = await loadRankedKeywords(supabase, workspaceId);

  const { data: existing } = await supabase
    .from("site_pages")
    .select("url, content_hash")
    .eq("workspace_id", workspaceId);
  const knownHash = new Map(
    (existing ?? []).map((r) => [r.url as string, r.content_hash as string | null]),
  );

  const pages: SitePage[] = [];
  let skipped = 0;
  let done = 0;

  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (queue.length) {
        // The budget is checked between pages, not inside one: a page already
        // in flight is cheaper to finish than to abandon, and the per-request
        // timeout bounds it anyway.
        if (Date.now() >= deadline) return;
        const url = queue.shift()!;
        const page = await crawlPage(url, { domain, rankedByPath, timeoutMs: opts.timeoutMs, techChecks });
        // Unchanged pages still get their timestamp moved, so a later run can
        // tell "checked and identical" from "never looked at".
        if (skipUnchanged && page.content_hash && knownHash.get(url) === page.content_hash) {
          skipped++;
        }
        pages.push(page);
        opts.onProgress?.(++done, urls.length);
        if (crawlDelayMs > 0 && queue.length) await new Promise((r) => setTimeout(r, crawlDelayMs));
      }
    }),
  );

  // Duplicates are the one question a single page cannot answer, so they are
  // asked here, over what this run actually read - which is the whole site
  // when it fitted inside the cap and the budget, and a subset otherwise.
  // `truncated` says which, and the surfaces that render this say so too.
  const truncated =
    discoveryTruncated || pages.length < urls.length || urls.length < allowed.length;
  if (techChecks) {
    const dupes = duplicateFindings(
      pages.map((p) => ({ url: p.url, title: p.title, metaDescription: p.meta_description, status: p.status })),
    );
    for (const page of pages) {
      const extra = dupes.get(page.url);
      if (!extra?.length) continue;
      page.tech_findings = [...(page.tech_findings ?? []), ...extra];
      page.tech_issue_count = page.tech_findings.length;
    }
  }

  // Upsert in chunks: one statement per page would be hundreds of round trips,
  // but 50 rows carrying audit and seo_checks JSON blew PostgREST's 8 s
  // statement_timeout. Ten is well inside it; a failure after some chunks
  // have landed is reported as a write failure so the caller can retry
  // tomorrow instead of marking the site crawled.
  for (let i = 0; i < pages.length; i += SITE_PAGES_UPSERT_CHUNK) {
    // Every row in a chunk carries the same keys. PostgREST refuses an array
    // whose objects differ ("All object keys must match"), and the tech
    // columns are set on some rows and not others - a page that was rendered
    // by the provider has no findings, and a non-HTML response has none either.
    const chunk = pages.slice(i, i + SITE_PAGES_UPSERT_CHUNK).map((p) => ({
      ...p,
      tech_findings: p.tech_findings ?? null,
      tech_issue_count: p.tech_issue_count ?? null,
      tech_checked_at: p.tech_checked_at ?? null,
      workspace_id: workspaceId,
      last_crawled_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("site_pages")
      .upsert(chunk, { onConflict: "workspace_id,url" });
    if (error) throw new SitePagesWriteError(`site_pages upsert: ${error.message}`, i);
  }

  return {
    discovered: all.length,
    fetched: pages.filter((p) => p.status >= 200 && p.status < 400).length,
    failed: pages.filter((p) => p.status === 0 || p.status >= 400).length,
    skipped,
    pages,
    tech: techChecks
      ? summarise(pages.map((p) => ({ findings: p.tech_findings ?? [] })))
      : null,
    disallowed,
    truncated,
    robotsBlocked,
  };
}

/**
 * The best-positioned ranked keyword for each of the site's own pages, from
 * the stored domain analysis. Null when nobody has analysed the domain, which
 * is not the same as the site ranking for nothing.
 */
async function loadRankedKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, { keyword: string; position: number | null }>> {
  const out = new Map<string, { keyword: string; position: number | null }>();
  const { data } = await supabase
    .from("domain_audits")
    .select("ranked_keywords")
    .eq("workspace_id", workspaceId)
    .not("ranked_keywords", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const ranked = (data?.ranked_keywords as RankedKeyword[] | null) ?? null;
  if (!ranked?.length) return out;

  for (const [path, kws] of groupByPage(ranked)) {
    const best = kws
      .filter((k) => k.position !== null)
      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))[0];
    if (best) out.set(path, { keyword: best.keyword, position: best.position });
  }
  return out;
}

/**
 * Recover a page our own fetch could not read, through DataForSEO's browser.
 *
 * Returns facts and no scores, on purpose. `instant_pages` gives counts,
 * headings and 52 checks but not markup, and the SEO and GEO scorers read
 * markup: they need to see whether a table exists, whether a heading is a
 * question, whether a figure sits in a paragraph that links its source.
 * Deriving a score from what is available here would produce a number built
 * on less evidence than every other number in the table, indistinguishable
 * from them. `rendered_by` marks the row so nothing downstream mistakes one
 * for the other.
 */
async function renderPage(
  url: string,
  path: string,
  ctx: PageContext,
): Promise<SitePage | null> {
  let facts: OnPageFacts | null = null;
  try {
    facts = await fetchInstantPage(url, { javascript: true });
  } catch (err) {
    console.warn(`[site-crawl] render failed for ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
  if (!facts || facts.statusCode >= 400) return null;

  const h1 = facts.h1[0] ?? null;
  return {
    url,
    path,
    page_type: classifyPageType(path),
    content_hash: null,
    title: facts.title,
    meta_description: facts.description,
    h1,
    word_count: facts.wordCount,
    // A keyword still costs nothing to infer, and makes the page a link
    // target. What it does not get is a score against that keyword.
    keyword: keywordForPage(path, h1, ctx.domain),
    keyword_source: "heading",
    position: ctx.rankedByPath?.get(path)?.position ?? null,
    seo_score: null,
    seo_checks: null,
    aeo_score: null,
    aeo_checks: null,
    audit: null,
    internal_links: facts.internalLinks,
    external_links: facts.externalLinks,
    published_at: null,
    modified_at: null,
    schema_types: null,
    status: facts.statusCode,
    error: null,
    rendered_by: "dataforseo",
    onpage_score: facts.onPageScore,
  };
}
