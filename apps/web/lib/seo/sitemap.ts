// ---------------------------------------------------------------------------
// Sitemaps, with their dates
// ---------------------------------------------------------------------------
//
// `discoverUrls` in site-crawl.ts reads a sitemap for the weekly crawl and
// keeps only the addresses. The found-on-site check needs one more fact per
// URL - when the site says the page last changed - because the question it
// asks is "which pages are NEW since this draft was written", and `<lastmod>`
// is the site's own answer to that.
//
// What this reads, all of it through a fetch the caller injects (so the SSRF
// guard stays on the path and the tests need no network):
//
//   - the `Sitemap:` lines of robots.txt, which the caller already parsed;
//     without any, the conventional /sitemap.xml, /sitemap_index.xml and
//     /sitemap-index.xml
//   - a `<sitemapindex>`: its children, newest `<lastmod>` first, so a Yoast
//     style index of fifteen post sitemaps reads the one with this week's
//     posts before the one from 2019. Nested indexes are followed to a
//     bounded depth.
//   - a `<urlset>`: every `<url>` with its `<loc>` and `<lastmod>`
//   - gzip: a `.xml.gz` served as a file (not as Content-Encoding, which the
//     fetch already undoes) is recognised by its magic bytes and inflated, up
//     to a cap, so a bomb stops where a large sitemap would
//   - a plain-text sitemap, one URL per line, which the protocol also allows
//
// Bounded three ways: sitemap files fetched, URLs kept, and a wall-clock
// deadline. Out of any of them returns what was found, with `truncated` set,
// rather than throwing.

import { gunzipSync } from "node:zlib";
import { decodeEntities } from "@/lib/audit/html-utils";

export interface SitemapEntry {
  loc: string;
  /** ISO timestamp from `<lastmod>`, or null when the entry has none or it does not parse. */
  lastmod: string | null;
}

export interface ParsedSitemap {
  kind: "index" | "urlset" | "text" | "unknown";
  entries: SitemapEntry[];
}

/** Text between `<tag>` and `</tag>`, namespace prefix and CDATA tolerated. */
function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, "i"));
  if (!m) return null;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  return raw ? decodeEntities(raw) : null;
}

/**
 * A W3C datetime as an ISO timestamp. A date alone ("2026-09-22") is midnight
 * UTC that day; the caller allows a day of slack for exactly that reason.
 */
export function parseLastmod(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!/^\d{4}(-\d{2}(-\d{2})?)?([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/i.test(v)) return null;
  const t = Date.parse(v.replace(" ", "T"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseSitemap(body: string): ParsedSitemap {
  const text = body.replace(/^﻿/, "");
  const blocks = (tag: string) =>
    [...text.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, "gi"))].map(
      (m) => m[1],
    );
  const toEntries = (list: string[]) =>
    list
      .map((b) => ({ loc: tagText(b, "loc"), lastmod: parseLastmod(tagText(b, "lastmod")) }))
      .filter((e): e is SitemapEntry => Boolean(e.loc));

  if (/<(?:[\w-]+:)?sitemapindex\b/i.test(text)) return { kind: "index", entries: toEntries(blocks("sitemap")) };
  if (/<(?:[\w-]+:)?urlset\b/i.test(text)) return { kind: "urlset", entries: toEntries(blocks("url")) };
  // Not XML at all: the protocol's text format, one absolute URL per line.
  if (!/<[a-z?!]/i.test(text)) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\/\S+$/i.test(l));
    return { kind: lines.length ? "text" : "unknown", entries: lines.map((loc) => ({ loc, lastmod: null })) };
  }
  return { kind: "unknown", entries: [] };
}

/** What the injected fetch returns. `body` is the decoded text, `bytes` the raw body for gzip sniffing. */
export interface SitemapFetchResult {
  status: number;
  body: string;
  bytes?: Buffer;
}

export type SitemapFetch = (url: string) => Promise<SitemapFetchResult>;

/** Inflated size cap for a gzipped sitemap. The protocol caps one file at 50 MB; nobody we read is near it. */
const MAX_INFLATED_BYTES = 10 * 1024 * 1024;

/** The sitemap text of a response, inflating a gzip file when that is what arrived. */
export function sitemapText(res: SitemapFetchResult): string | null {
  const b = res.bytes;
  if (b && b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) {
    try {
      return gunzipSync(b, { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
    } catch {
      return null; // truncated, corrupt, or over the cap
    }
  }
  return res.body;
}

export interface DiscoverOptions {
  /** `Sitemap:` lines from robots.txt. Empty or absent means try the conventional paths. */
  declared?: string[];
  /** Whether a URL may be fetched (robots.txt). Declared sitemaps are read regardless: the site listed them. */
  allowed?: (url: string) => boolean;
  /** Sitemap files fetched, in total. */
  maxSitemaps?: number;
  /** Page entries kept, in total. */
  maxUrls?: number;
  /** Index nesting followed below the roots. */
  maxDepth?: number;
  /** Wall-clock stop, in Date.now() terms. */
  deadline?: number;
}

export interface Discovery {
  entries: SitemapEntry[];
  /** Sitemap files that were read and parsed. */
  sitemapsRead: string[];
  /** Sitemap files that answered with something other than a sitemap, or not at all. */
  sitemapsFailed: string[];
  /** A bound stopped the walk before it finished. */
  truncated: boolean;
}

/** Newest lastmod first; undated after dated, in their original order. */
function newestFirst<T extends { lastmod: string | null }>(list: T[]): T[] {
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.lastmod && b.e.lastmod) return b.e.lastmod.localeCompare(a.e.lastmod) || a.i - b.i;
      if (a.e.lastmod) return -1;
      if (b.e.lastmod) return 1;
      return a.i - b.i;
    })
    .map(({ e }) => e);
}

/**
 * Every page URL the site's sitemaps declare, with its lastmod. Deduplicated
 * by URL; when two sitemaps list one URL, the later lastmod wins.
 */
export async function discoverSitemapEntries(
  origin: string,
  fetch: SitemapFetch,
  opts: DiscoverOptions = {},
): Promise<Discovery> {
  const base = origin.replace(/\/$/, "");
  const maxSitemaps = opts.maxSitemaps ?? 12;
  const maxUrls = opts.maxUrls ?? 5000;
  const maxDepth = opts.maxDepth ?? 2;
  const allowed = opts.allowed ?? (() => true);
  const outOfTime = () => opts.deadline !== undefined && Date.now() >= opts.deadline;

  const declared = [...new Set(opts.declared ?? [])];
  const roots = declared.length
    ? declared.map((loc) => ({ loc, trusted: true }))
    : ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"].map((p) => ({ loc: `${base}${p}`, trusted: false }));

  const byUrl = new Map<string, string | null>();
  const sitemapsRead: string[] = [];
  const sitemapsFailed: string[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  let truncated = false;

  // Breadth-first over (url, depth). Roots are tried in order; the fallback
  // paths stop at the first that is a sitemap, since they are three guesses at
  // one file.
  const queue: Array<{ loc: string; depth: number; trusted: boolean }> = roots.map((r) => ({ ...r, depth: 0 }));
  let fallbackFound = false;
  while (queue.length) {
    const next = queue.shift()!;
    if (!declared.length && next.depth === 0 && fallbackFound) continue;
    if (seen.has(next.loc)) continue;
    seen.add(next.loc);
    if (fetched >= maxSitemaps || outOfTime() || byUrl.size >= maxUrls) {
      truncated = true;
      break;
    }
    if (!next.trusted && !allowed(next.loc)) continue;

    fetched++;
    let parsed: ParsedSitemap;
    try {
      const res = await fetch(next.loc);
      const text = res.status >= 200 && res.status < 300 ? sitemapText(res) : null;
      parsed = text === null ? { kind: "unknown", entries: [] } : parseSitemap(text);
    } catch {
      parsed = { kind: "unknown", entries: [] };
    }
    if (parsed.kind === "unknown") {
      sitemapsFailed.push(next.loc);
      continue;
    }
    sitemapsRead.push(next.loc);
    if (next.depth === 0) fallbackFound = true;

    if (parsed.kind === "index") {
      if (next.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      for (const child of newestFirst(parsed.entries)) {
        queue.push({ loc: child.loc, depth: next.depth + 1, trusted: false });
      }
      continue;
    }
    for (const e of parsed.entries) {
      const prev = byUrl.get(e.loc);
      if (prev === undefined) {
        if (byUrl.size >= maxUrls) {
          truncated = true;
          break;
        }
        byUrl.set(e.loc, e.lastmod);
      } else if (e.lastmod && (!prev || e.lastmod > prev)) {
        byUrl.set(e.loc, e.lastmod);
      }
    }
  }

  return {
    entries: [...byUrl].map(([loc, lastmod]) => ({ loc, lastmod })),
    sitemapsRead,
    sitemapsFailed,
    truncated,
  };
}
