// ---------------------------------------------------------------------------
// Sitemap checker: find the sitemaps, read them, and spot-check the URLs
// ---------------------------------------------------------------------------
//
// Discovery is the order a crawler uses: the URL given if it is a sitemap,
// then `Sitemap:` lines in robots.txt, then /sitemap.xml and
// /sitemap_index.xml. Index files are followed to their children. Bounded on
// every axis (files, URLs, sampled URLs) so one huge site costs the same as a
// small one; the output says when a bound was hit.

import { z } from "zod";
import { gunzipSync } from "node:zlib";
import { defineTool, type ToolContext } from "../types";
import { parsePublicUrl } from "../url";
import { kv, list, table, type Block, type KvItem } from "../blocks";
import { ToolError } from "../errors";
import { FetchFailedError, UnsafeUrlError, decodeBody } from "../safe-fetch";
import { loadRobotsTxt } from "../robots";
import { decode, mapLimit, clip } from "../html";

export const MAX_FILES = 5;
export const MAX_URLS = 5_000;
export const SAMPLE_SIZE = 10;
const MAX_FILE_BYTES = 10_000_000;

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface ParsedSitemap {
  kind: "index" | "urlset" | "unknown";
  entries: SitemapEntry[];
}

/** W3C Datetime, the format the sitemap protocol requires for <lastmod>. */
const W3C_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

export function isValidLastmod(v: string): boolean {
  return W3C_DATE.test(v.trim());
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const kind = /<(?:\w+:)?sitemapindex[\s>]/i.test(body) ? "index" : /<(?:\w+:)?urlset[\s>]/i.test(body) ? "urlset" : "unknown";
  const tag = kind === "index" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}\\s*>`, "gi");
  for (const m of body.matchAll(re)) {
    const inner = m[1];
    const loc = inner.match(/<(?:\w+:)?loc(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?loc\s*>/i)?.[1];
    const lastmod = inner.match(/<(?:\w+:)?lastmod(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?lastmod\s*>/i)?.[1];
    const clean = (s: string) => decode(s.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ""));
    entries.push({ loc: loc ? clean(loc) : "", lastmod: lastmod ? clean(lastmod) : null });
  }
  return { kind, entries };
}

interface FileReport {
  url: string;
  status: number | null;
  kind: ParsedSitemap["kind"] | "error";
  entries: number;
  note: string;
}

async function fetchSitemap(url: string, ctx: ToolContext): Promise<{ report: FileReport; parsed: ParsedSitemap | null }> {
  try {
    const res = await ctx.fetch(url, {
      signal: ctx.signal,
      maxBytes: MAX_FILE_BYTES,
      timeoutMs: 15_000,
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" },
    });
    if (res.status !== 200) {
      return { report: { url, status: res.status, kind: "error", entries: 0, note: `HTTP ${res.status}` }, parsed: null };
    }
    let xml = res.body;
    // A .xml.gz served as a file, not with Content-Encoding.
    if (res.bodyBuffer[0] === 0x1f && res.bodyBuffer[1] === 0x8b) {
      try {
        xml = decodeBody(gunzipSync(res.bodyBuffer, { maxOutputLength: MAX_FILE_BYTES }), "");
      } catch {
        return { report: { url, status: res.status, kind: "error", entries: 0, note: "gzip file could not be decompressed within the size limit" }, parsed: null };
      }
    }
    const parsed = parseSitemapXml(xml);
    const notes: string[] = [];
    if (res.url !== url) notes.push(`redirected to ${res.url}`);
    if (res.truncated) notes.push("over 10 MB; only the start was read");
    if (parsed.kind === "unknown") notes.push(/^\s*<(!doctype|html)/i.test(xml) ? "an HTML page, not a sitemap" : "not a sitemap (no <urlset> or <sitemapindex>)");
    if (parsed.entries.length > 50_000) notes.push("over the 50,000-URL limit per file");
    return {
      report: { url, status: res.status, kind: parsed.kind, entries: parsed.entries.length, note: notes.join("; ") },
      parsed: parsed.kind === "unknown" ? null : parsed,
    };
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return { report: { url, status: null, kind: "error", entries: 0, note: `not fetched: ${err.message}` }, parsed: null };
    }
    return { report: { url, status: null, kind: "error", entries: 0, note: err instanceof FetchFailedError ? err.message : "request failed" }, parsed: null };
  }
}

/** Evenly spread picks, first and last included. */
export function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = (items.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => items[Math.round(i * step)]);
}

const input = z
  .object({ url: z.string().optional(), domain: z.string().optional() })
  .transform((v, ctx) => {
    const raw = v.url ?? v.domain;
    const r = parsePublicUrl(raw ?? "");
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return { url: r.url };
  });

export const sitemapChecker = defineTool({
  slug: "sitemap-checker",
  kind: "fetch",
  input,
  perIpLimit: { limit: 10, windowMs: 60 * 60 * 1000 },
  estimateCents: 0,
  async run({ url }, ctx) {
    const origin = new URL(url).origin;
    const given = new URL(url);
    const discovery: string[] = [];
    let candidates: string[] = [];

    if (/\.xml(\.gz)?$/i.test(given.pathname) || /sitemap/i.test(given.pathname)) {
      candidates = [url];
      discovery.push(`Using the sitemap URL given: ${url}`);
    } else {
      const robots = await loadRobotsTxt(url, ctx.fetch, { signal: ctx.signal }).catch((err) => {
        if (err instanceof UnsafeUrlError) throw new ToolError("invalid_input", err.message);
        throw err;
      });
      const declared = robots.parsed.sitemaps.filter((s) => {
        try {
          const u = new URL(s);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      });
      if (declared.length) {
        candidates = declared;
        discovery.push(`robots.txt declares ${declared.length} sitemap${declared.length === 1 ? "" : "s"}.`);
      } else {
        discovery.push(
          robots.state === "fetched" ? "robots.txt has no Sitemap line; trying the usual locations." : "No readable robots.txt; trying the usual locations.",
        );
        candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
      }
    }

    const files: FileReport[] = [];
    const urls: SitemapEntry[] = [];
    const queue = [...new Set(candidates)];
    const seen = new Set<string>();
    let hitFileCap = false;
    let hitUrlCap = false;
    let foundFallback = false;

    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      if (files.length >= MAX_FILES) {
        hitFileCap = true;
        break;
      }
      // The fallback pair: stop at the first that works.
      if (foundFallback && next === `${origin}/sitemap_index.xml`) continue;
      seen.add(next);
      const { report, parsed } = await fetchSitemap(next, ctx);
      files.push(report);
      if (!parsed) continue;
      if (next === `${origin}/sitemap.xml`) foundFallback = true;
      if (parsed.kind === "index") {
        for (const e of parsed.entries) if (e.loc && !seen.has(e.loc)) queue.push(e.loc);
      } else {
        for (const e of parsed.entries) {
          if (urls.length >= MAX_URLS) {
            hitUrlCap = true;
            break;
          }
          urls.push(e);
        }
      }
      if (hitUrlCap) break;
    }
    if (queue.length && !hitUrlCap && files.length >= MAX_FILES) hitFileCap = true;

    const good = files.filter((f) => f.kind === "urlset" || f.kind === "index");
    if (!good.length) {
      const items: KvItem[] = [{ label: "Sitemap", value: "none found", status: "fail" }];
      return [kv(items, "Sitemap"), list(discovery, "Discovery"), table(["File", "HTTP", "Type", "Entries", "Note"], files.map((f) => [f.url, f.status, f.kind, f.entries, f.note]), "Tried")];
    }

    // Entry quality.
    const pageHost = new URL(url).hostname.replace(/^www\./, "");
    const invalid: string[] = [];
    const locs = new Set<string>();
    let dupes = 0;
    let withLastmod = 0;
    let badLastmod = 0;
    let offHost = 0;
    let badLoc = 0;
    for (const e of urls) {
      if (!e.loc) {
        badLoc++;
        if (invalid.length < 50) invalid.push("an entry with no <loc>");
        continue;
      }
      let u: URL | null = null;
      try {
        u = new URL(e.loc);
      } catch {
        /* invalid */
      }
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
        badLoc++;
        if (invalid.length < 50) invalid.push(`not an absolute URL: ${clip(e.loc, 100)}`);
        continue;
      }
      if (u.hostname.replace(/^www\./, "") !== pageHost) offHost++;
      if (locs.has(e.loc)) dupes++;
      locs.add(e.loc);
      if (e.lastmod) {
        withLastmod++;
        if (!isValidLastmod(e.lastmod)) {
          badLastmod++;
          if (invalid.length < 50) invalid.push(`invalid <lastmod> "${clip(e.lastmod, 40)}" on ${clip(e.loc, 80)}`);
        }
      }
    }

    const picks = sample([...locs], SAMPLE_SIZE);
    const checks = await mapLimit(picks, 5, async (loc) => {
      try {
        let r = await ctx.fetch(loc, { method: "HEAD", signal: ctx.signal, followRedirects: false, timeoutMs: 8_000 });
        if (r.status === 405 || r.status === 501) {
          r = await ctx.fetch(loc, { signal: ctx.signal, followRedirects: false, timeoutMs: 8_000, maxBytes: 200_000 });
        }
        const xr = r.headers["x-robots-tag"] ?? "";
        const note =
          r.status >= 300 && r.status < 400
            ? `redirects to ${r.headers.location ?? "?"}`
            : /noindex/i.test(xr)
              ? "X-Robots-Tag: noindex"
              : r.status >= 400
                ? "error"
                : "";
        return [loc, r.status, note] as (string | number | null)[];
      } catch (err) {
        return [loc, null, err instanceof Error ? err.message : "request failed"] as (string | number | null)[];
      }
    });
    const sampleBad = checks.filter((c) => c[1] !== 200 || c[2]).length;

    const pct = (n: number) => (urls.length ? `${Math.round((n / urls.length) * 100)}%` : "0%");
    const items: KvItem[] = [
      { label: "Sitemap files read", value: `${good.length}${hitFileCap ? ` (stopped at ${MAX_FILES}; there are more)` : ""}`, status: "pass" },
      { label: "URLs listed", value: `${urls.length.toLocaleString("en")}${hitUrlCap ? ` (stopped counting at ${MAX_URLS.toLocaleString("en")})` : ""}`, status: urls.length ? "pass" : "warn" },
      { label: "With <lastmod>", value: `${withLastmod.toLocaleString("en")} (${pct(withLastmod)})`, status: withLastmod === 0 ? "warn" : withLastmod < urls.length ? "info" : "pass" },
      { label: "Invalid <lastmod>", value: String(badLastmod), status: badLastmod ? "warn" : "pass" },
      { label: "Invalid entries", value: String(badLoc), status: badLoc ? "fail" : "pass" },
      { label: "Duplicate URLs", value: String(dupes), status: dupes ? "warn" : "pass" },
      { label: "On another host", value: String(offHost), status: offHost ? "warn" : "pass" },
      {
        label: `Sampled URLs (${picks.length})`,
        value: sampleBad ? `${sampleBad} did not answer a clean 200` : "all answer 200",
        status: sampleBad ? "fail" : "pass",
      },
    ];

    const blocks: Block[] = [
      kv(items, "Sitemap"),
      list(discovery, "Discovery"),
      table(["File", "HTTP", "Type", "Entries", "Note"], files.map((f) => [f.url, f.status, f.kind, f.entries, f.note]), "Files"),
      table(["URL", "HTTP", "Note"], checks, "Sample check"),
    ];
    if (invalid.length) blocks.push(list(invalid.slice(0, 50), "Invalid entries"));
    if (offHost) blocks.push(list([`${offHost} URLs are on a different host than ${pageHost}. Search engines ignore sitemap URLs for other hosts unless both are verified together.`], "Note"));
    return blocks;
  },
});
