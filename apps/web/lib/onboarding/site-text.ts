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

import { scrapeWebsiteText } from "@/lib/scraper";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { fetchInstantPage } from "@/lib/audit/onpage";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { discoverSite } from "./site-discovery";
import { e2eStubsEnabled, stubReadSiteText } from "@/lib/e2e/stubs";

export type SiteTextSource = "static" | "sitemap" | "rendered" | "none";

export interface SiteText {
  text: string;
  source: SiteTextSource;
  chars: number;
}

export const MIN_CHARS = 400;
const PAGE_TIMEOUT_MS = 8_000;

async function pageText(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    const res = await fetchSite(url, { headers: { "User-Agent": "AltoRankBot/1.0 (content analysis)" }, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return "";
    const html = await res.text();
    const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
    return body
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

export async function readSiteText(domain: string, maxChars = 12_000): Promise<SiteText> {
  // E2E_STUBS: fixture text, no fetch (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubReadSiteText(domain, maxChars);
  const done = (text: string, source: SiteTextSource): SiteText => ({ text: text.slice(0, maxChars), source, chars: text.length });

  // Discovery is needed by the next wizard screen anyway and is cheap, so it
  // runs alongside the static read instead of after it.
  const [stat, discovery] = await Promise.all([
    scrapeWebsiteText(domain).catch(() => ""),
    discoverSite(domain).catch(() => null),
  ]);
  if (stat.length >= MIN_CHARS) return done(stat, "static");

  if (discovery?.exampleArticleUrls.length) {
    const parts = await Promise.all(discovery.exampleArticleUrls.slice(0, 3).map(pageText));
    const joined = [stat, ...parts].filter(Boolean).join("\n\n");
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
