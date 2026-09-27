import { fetchSite } from "@/lib/audit/lenient-fetch";
/**
import { fetchSite } from "@/lib/audit/lenient-fetch";
 * Lightweight website text extractor — no dependencies beyond `fetch`.
 * Strips non-content tags, extracts text from content elements,
 * and optionally follows blog links for richer voice samples.
 */

const MAX_WORDS = 3000;
const FETCH_TIMEOUT = 8000;

export async function scrapeWebsiteText(domain: string): Promise<string> {
  return (await scrapeWebsite(domain)).text;
}

/** A page this read fetched and got a 2xx for, with the URL it ended on. */
export interface ScrapedPage {
  url: string;
  html: string;
}

/**
 * The text, plus the pages it came from. The pages are what lets a caller
 * say "this URL was on the site" rather than "the model thought it might
 * be": the wizard's profile read keeps them for exactly that
 * (lib/onboarding/observed-facts.ts).
 */
export async function scrapeWebsite(domain: string): Promise<{ text: string; pages: ScrapedPage[] }> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  const home = await fetchPage(url);
  if (!home) return { text: "", pages: [] };
  const pages: ScrapedPage[] = [home];

  let text = extractContentText(home.html);

  // Try to find and fetch a blog post for richer sample
  const blogLinks = findBlogLinks(home.html, home.url);
  if (blogLinks.length > 0) {
    const blog = await fetchPage(blogLinks[0]);
    if (blog) {
      pages.push(blog);
      text += "\n\n" + extractContentText(blog.html);
    }
  }

  // Cap at MAX_WORDS
  const words = text.split(/\s+/).filter(Boolean);
  return { text: words.slice(0, MAX_WORDS).join(" "), pages };
}

async function fetchPage(url: string): Promise<ScrapedPage | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetchSite(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AltoRankBot/1.0 (content analysis)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    // `res.url` is where redirects ended; a synthesised response has none.
    return { url: res.url || url, html: await res.text() };
  } catch {
    return null;
  }
}

function extractContentText(html: string): string {
  // Remove script, style, nav, header, footer tags and their content
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Try to extract from <main> or <article> first (most relevant content)
  const mainMatch = cleaned.match(/<main[\s\S]*?<\/main>/i);
  const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i);
  if (mainMatch) cleaned = mainMatch[0];
  else if (articleMatch) cleaned = articleMatch[0];

  // Extract text from paragraphs and headings
  const textParts: string[] = [];
  const contentPattern = /<(?:p|h[1-6]|li|blockquote|figcaption)[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote|figcaption)>/gi;
  let match;
  while ((match = contentPattern.exec(cleaned)) !== null) {
    const text = match[1]
      .replace(/<[^>]+>/g, "") // strip inner HTML tags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Entities decode AFTER the tag strip, so markup that arrived
      // entity-encoded (Next.js flight payloads, escaped attributes) survives
      // the strip and decodes into fragments like `')">Solutions`. Cal.com's
      // voice profile trained on exactly that, and the Voice page displayed
      // it as a "sample sentence". Strip once more after decoding, and drop
      // any part that still looks like attribute residue - a sentence a human
      // wrote does not contain `="` or `">`.
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const looksLikeMarkup = /["'][)\]]*\s*>|\w+=["']/.test(text);
    if (text.length > 20 && !looksLikeMarkup) {
      textParts.push(text);
    }
  }

  return textParts.join("\n\n");
}

function findBlogLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    if (/\/(blog|post|article|news)\//i.test(href)) {
      try {
        const resolved = new URL(href, baseUrl).toString();
        if (!links.includes(resolved)) links.push(resolved);
      } catch {
        // skip invalid URLs
      }
    }
  }
  return links.slice(0, 2);
}
