/**
 * Lightweight website text extractor — no dependencies beyond `fetch`.
 * Strips non-content tags, extracts text from content elements,
 * and optionally follows blog links for richer voice samples.
 */

const MAX_WORDS = 3000;
const FETCH_TIMEOUT = 8000;

export async function scrapeWebsiteText(domain: string): Promise<string> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  const html = await fetchPage(url);
  if (!html) return "";

  let text = extractContentText(html);

  // Try to find and fetch a blog post for richer sample
  const blogLinks = findBlogLinks(html, url);
  if (blogLinks.length > 0) {
    const blogHtml = await fetchPage(blogLinks[0]);
    if (blogHtml) {
      text += "\n\n" + extractContentText(blogHtml);
    }
  }

  // Cap at MAX_WORDS
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_WORDS).join(" ");
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AltoRankBot/1.0 (content analysis)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
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
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 20) {
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
