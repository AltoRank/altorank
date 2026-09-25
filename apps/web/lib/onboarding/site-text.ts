// ---------------------------------------------------------------------------
// Read a site well enough to describe it
// ---------------------------------------------------------------------------
//
// `scrapeWebsiteText` does one GET and strips tags. That is enough for a
// server-rendered page and returns nothing for a Framer, Webflow or React
// marketing site, whose HTML is an empty shell until JavaScript runs. The
// first wizard then showed blank fields under "we've filled this in".
//
// Three sources, tried in order of cost, and the answer says which one
// worked so the screen can be honest about it:
//
//   static     the homepage, plus one blog post the scraper finds itself
//   sitemap    up to three article URLs from the sitemap; blogs are usually
//              server-rendered even when the homepage is not
//   rendered   DataForSEO renders the homepage in a real browser; we get the
//              title, description and headings, which is thin but true
//
// Anything under MIN_CHARS is reported as `none` rather than guessed from.
//
// The read also says which pages answered and which links were on them
// (`observed`). The profile read used to hand the model tags-stripped text
// and ask it for a contact URL, so the URL it returned was a guess: a real
// signup, 2026-09-22, got /iletisim stored as observed, and it was a 404.
// Now the model is shown these links and anything it names is checked
// against them (lib/onboarding/observed-facts.ts).

import { scrapeWebsite, type ScrapedPage } from "@/lib/scraper";
import { extractLinks, normaliseSiteUrl } from "@/lib/seo/links";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { fetchInstantPage } from "@/lib/audit/onpage";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { discoverSite } from "./site-discovery";
import { e2eStubsEnabled, stubReadSiteText } from "@/lib/e2e/stubs";

export type SiteTextSource = "static" | "sitemap" | "rendered" | "none";

/** A link seen on a page this read fetched, as the page wrote it. */
export interface ObservedLink {
  text: string;
  /** Absolute. */
  url: string;
}

/** What the read can vouch for: pages that answered 2xx, and the same-site links on them. */
export interface ObservedSite {
  /** URLs that answered 2xx, as they ended after redirects. */
  pages: string[];
  /** Same-site links found on those pages, first seen first, deduplicated. */
  links: ObservedLink[];
}

export interface SiteText {
  text: string;
  source: SiteTextSource;
  chars: number;
  /** Absent from fixtures and from callers that never fetched anything. */
  observed?: ObservedSite;
}

/** Enough links to include a site's whole navigation and footer. */
const MAX_OBSERVED_LINKS = 80;

/**
 * The pages and same-site links a read can vouch for. Exported for tests:
 * this is the evidence an "observed" URL in the profile must be found in.
 *
 * `probed` are pages fetched at a path WE guessed (`/pricing`, `/about`).
 * Their links count - the site wrote them - but their own URLs do not: a
 * site that answers 200 for every path (a soft 404, a single-page app's
 * shell) would otherwise turn our guess into an "observed" page, which is
 * the guessed path the observed check exists to refuse. A probed page the
 * site really has is linked from one of its pages, and is checked as a link.
 */
export function observedFrom(domain: string, pages: ScrapedPage[], probed: ScrapedPage[] = []): ObservedSite {
  const seenPages = new Set<string>();
  const out: ObservedSite = { pages: [], links: [] };
  const seenLinks = new Set<string>();
  const vouched = new Set(pages);
  for (const page of [...pages, ...probed]) {
    const pageKey = normaliseSiteUrl(page.url, domain);
    if (vouched.has(page) && !seenPages.has(pageKey)) {
      seenPages.add(pageKey);
      out.pages.push(page.url);
    }
    for (const link of extractLinks(page.html, domain)) {
      if (link.kind !== "internal" || !link.href || out.links.length >= MAX_OBSERVED_LINKS) continue;
      let abs: string;
      try {
        abs = new URL(link.href, page.url).href;
      } catch {
        continue;
      }
      const key = normaliseSiteUrl(abs, domain);
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      out.links.push({ text: link.anchor.slice(0, 80), url: abs });
    }
  }
  return out;
}

export const MIN_CHARS = 400;
const PAGE_TIMEOUT_MS = 8_000;

/** One page's text, and the page itself when it answered 2xx. */
async function pageText(url: string): Promise<{ text: string; page: ScrapedPage | null }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    const res = await fetchSite(url, { headers: { "User-Agent": "AltoRankBot/1.0 (content analysis)" }, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return { text: "", page: null };
    const html = await res.text();
    const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
    const text = body
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { text, page: { url: res.url || url, html } };
  } catch {
    return { text: "", page: null };
  }
}

export async function readSiteText(domain: string, maxChars = 12_000): Promise<SiteText> {
  // E2E_STUBS: fixture text, no fetch (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubReadSiteText(domain, maxChars);
  // Every page that answered, whichever branch below returns: the evidence
  // an observed URL in the profile is checked against. Pages at paths we
  // guessed are kept apart: their links are evidence, their URLs are not.
  const fetched: ScrapedPage[] = [];
  const probed: ScrapedPage[] = [];
  const done = (text: string, source: SiteTextSource): SiteText => ({
    text: text.slice(0, maxChars),
    source,
    chars: text.length,
    observed: observedFrom(domain, fetched, probed),
  });

  // Discovery is needed by the next wizard screen anyway and is cheap, so it
  // runs alongside the static read instead of after it.
  const [scraped, discovery] = await Promise.all([
    scrapeWebsite(domain).catch(() => ({ text: "", pages: [] as ScrapedPage[] })),
    discoverSite(domain).catch(() => null),
  ]);
  fetched.push(...scraped.pages);
  const rawStatic = scraped.text;
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  const productPages = await Promise.all(["/pricing", "/features", "/about"].map(async (path) => {
    const url = new URL(path, base).href;
    const { text, page } = await pageText(url);
    if (page) probed.push(page);
    return text.length >= 150 ? `SOURCE ${url}\n${text.slice(0, 1500)}` : "";
  }));
  const stat = [...productPages.filter(Boolean), `HOMEPAGE/BLOG CONTEXT\n${rawStatic}`].join("\n\n");
  if (stat.length >= MIN_CHARS) return done(stat, "static");

  if (discovery?.exampleArticleUrls.length) {
    const read = await Promise.all(discovery.exampleArticleUrls.slice(0, 3).map(pageText));
    for (const r of read) if (r.page) fetched.push(r.page);
    const joined = [stat, ...read.map((r) => r.text)].filter(Boolean).join("\n\n");
    if (joined.length >= MIN_CHARS) return done(joined, "sitemap");
  }

  if (hasDataForSEOCredentials()) {
    const url = domain.startsWith("http") ? domain : `https://${domain}`;
    const facts = await fetchInstantPage(url, { javascript: true }).catch(() => null);
    if (facts) {
      const rendered = [facts.title, facts.description, ...facts.h1, ...facts.h2].filter(Boolean).join(". ");
      const joined = [stat, rendered].filter(Boolean).join("\n\n");
      if (joined.length >= Math.min(MIN_CHARS, 250)) return done(joined, "rendered");
    }
  }

  return done(stat, "none");
}
