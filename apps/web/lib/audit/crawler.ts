// Browser-shaped and honestly identified. A bare tool UA gets a WAF
// challenge or a stripped page from a share of real sites (the readiness
// checker learned this across 272 agency sites); the identifier stays so a
// site owner can see who visited.
import { fetchLenient, isTlsChainError } from "./lenient-fetch";

const CRAWLER_UA =
  "Mozilla/5.0 (compatible; AltoRank-Auditor/1.0; +https://altorank.co; site audit)";

export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const code = e?.cause?.code;
  if (e?.name === "AbortError") return "timed out after 10s";
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return `TLS certificate could not be verified (${code}); browsers may cope, crawlers will not`;
  }
  if (code === "ENOTFOUND") return "host not found";
  if (code === "ECONNREFUSED") return "connection refused";
  return code ?? e?.message ?? "fetch failed";
}

/** Pages that actually answered. Everything that scores or profiles a site
 *  must start from this, never from the raw crawl, or a failed fetch becomes
 *  a page with no title, no headings, a clean audit and an empty profile. */
export function usablePages<T extends { status: number }>(pages: T[]): T[] {
  return pages.filter((p) => p.status >= 200 && p.status < 400);
}

export interface CrawlResult {
  /** Set when status is 0: why no response came back. */
  error?: string;
  /** The page was read over a TLS chain Node could not verify. */
  tlsUnverified?: boolean;
  url: string;
  status: number;
  title: string;
  metaDescription: string;
  h1: string[];
  h2: string[];
  images: Array<{ src: string; alt: string }>;
  links: Array<{ href: string; text: string; isInternal: boolean }>;
  loadTimeMs: number;
}

/**
 * BFS site crawler - rate-limited, max 100 pages, depth 3.
 */
export async function crawlSite(
  baseUrl: string,
  maxPages = 100,
  maxDepth = 3,
  delayMs = 500,
): Promise<CrawlResult[]> {
  const base = new URL(baseUrl);
  const visited = new Set<string>();
  const results: CrawlResult[] = [];

  type QueueItem = { url: string; depth: number };
  const queue: QueueItem[] = [{ url: base.href, depth: 0 }];

  while (queue.length > 0 && results.length < maxPages) {
    const item = queue.shift()!;
    const normalizedUrl = normalizeUrl(item.url);

    if (visited.has(normalizedUrl)) continue;
    if (item.depth > maxDepth) continue;
    visited.add(normalizedUrl);

    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(item.url, {
        signal: controller.signal,
        headers: { "User-Agent": CRAWLER_UA },
        redirect: "follow",
      });

      clearTimeout(timeout);
      const loadTimeMs = Date.now() - start;

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        results.push({
          url: item.url, status: res.status, title: "", metaDescription: "",
          h1: [], h2: [], images: [], links: [], loadTimeMs,
        });
        continue;
      }

      const html = await res.text();
      const parsed = parseHtml(html, item.url, base.origin);

      results.push({ url: item.url, status: res.status, loadTimeMs, ...parsed });

      // Enqueue internal links
      if (item.depth < maxDepth) {
        for (const link of parsed.links) {
          if (link.isInternal && !visited.has(normalizeUrl(link.href))) {
            queue.push({ url: link.href, depth: item.depth + 1 });
          }
        }
      }

      // Rate limit
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      // A chain Node cannot verify (www.lully.ai serves no intermediate,
      // 2026-09-02) is a finding about the site, not a reason to see nothing.
      // Read it without verification, mark the page, and let the audit report
      // the chain as an issue.
      if (isTlsChainError(err)) {
        try {
          const start = Date.now();
          const r = await fetchLenient(item.url, { userAgent: CRAWLER_UA, timeoutMs: 10_000 });
          const loadTimeMs = Date.now() - start;
          if ((r.headers["content-type"] ?? "").includes("text/html")) {
            const parsed = parseHtml(r.body, item.url, base.origin);
            results.push({ url: item.url, status: r.status, loadTimeMs, tlsUnverified: true, ...parsed });
            if (item.depth < maxDepth) {
              for (const link of parsed.links) {
                if (link.isInternal && !visited.has(normalizeUrl(link.href))) {
                  queue.push({ url: link.href, depth: item.depth + 1 });
                }
              }
            }
          } else {
            results.push({ url: item.url, status: r.status, title: "", metaDescription: "", h1: [], h2: [], images: [], links: [], loadTimeMs, tlsUnverified: true });
          }
          continue;
        } catch (err2) {
          err = err2;
        }
      }
      // Status 0 is "we never got a response". Keep the reason: the
      // difference between a TLS error and a timeout is what the owner needs.
      results.push({
        url: item.url, status: 0, title: "", metaDescription: "",
        h1: [], h2: [], images: [], links: [], loadTimeMs: 0,
        error: describeFetchError(err),
      });
    }
  }

  return results;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function parseHtml(
  html: string,
  pageUrl: string,
  origin: string,
): Omit<CrawlResult, "url" | "status" | "loadTimeMs"> {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";

  const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    ?? html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  const metaDescription = metaMatch?.[1]?.trim() ?? "";

  const h1: string[] = [];
  const h1Pattern = /<h1[^>]*>([^<]*)<\/h1>/gi;
  let m: RegExpExecArray | null;
  while ((m = h1Pattern.exec(html)) !== null) h1.push(m[1].trim());

  const h2: string[] = [];
  const h2Pattern = /<h2[^>]*>([^<]*)<\/h2>/gi;
  while ((m = h2Pattern.exec(html)) !== null) h2.push(m[1].trim());

  const images: Array<{ src: string; alt: string }> = [];
  const imgPattern = /<img\s+[^>]*src=["']([^"']*)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
  while ((m = imgPattern.exec(html)) !== null) {
    images.push({ src: m[1], alt: m[2] ?? "" });
  }

  const links: Array<{ href: string; text: string; isInternal: boolean }> = [];
  const linkPattern = /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi;
  while ((m = linkPattern.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].trim();
    try {
      const resolved = new URL(href, pageUrl);
      const isInternal = resolved.origin === origin;
      links.push({ href: resolved.href, text, isInternal });
    } catch {
      // Skip invalid URLs
    }
  }

  return { title, metaDescription, h1, h2, images, links };
}
