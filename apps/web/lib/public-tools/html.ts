// ---------------------------------------------------------------------------
// Reading raw HTML the way a non-rendering crawler does
// ---------------------------------------------------------------------------
//
// No DOM and no JavaScript, on purpose: what these tools report is what a
// crawler that does not render sees. Tag matching tolerates attributes in
// any order, either quote style, unquoted values and a `>` inside a quoted
// value, which the older regexes in lib/tools/generate-health.ts do not
// (they need `name` before `content`). Comments are removed first, so a
// commented-out tag is not reported as present.

import { decode, decodeEntities, stripTags } from "@/lib/audit/html-utils";

export { decode, stripTags };

/** Everything between `<` and `>` of a start tag, quotes respected. */
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Lower-cased attribute names to entity-decoded values. A bare attribute maps to "". */
export function parseAttributes(inside: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of inside.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (name in out) continue; // the first occurrence wins, as in a browser
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export interface Tag {
  attrs: Record<string, string>;
  /** Offset in the (comment-stripped) HTML. */
  index: number;
}

/** Every start tag `<name ...>`. For void elements (meta, link, base, html). */
export function findTags(html: string, name: string): Tag[] {
  const re = new RegExp(`<${name}(?=[\\s/>])${ATTRS}>`, "gi");
  return [...html.matchAll(re)].map((m) => ({ attrs: parseAttributes(m[1].replace(/\/$/, "")), index: m.index ?? 0 }));
}

export interface Element extends Tag {
  inner: string;
}

/** Every `<name ...>inner</name>`. Not nested-aware: fine for a, title, h1, script. */
export function findElements(html: string, name: string): Element[] {
  const re = new RegExp(`<${name}(?=[\\s>])${ATTRS}>([\\s\\S]*?)</${name}\\s*>`, "gi");
  return [...html.matchAll(re)].map((m) => ({ attrs: parseAttributes(m[1]), inner: m[2], index: m.index ?? 0 }));
}

/** The <head> part: up to </head>, or up to <body> when the close tag is missing. */
export function headOf(html: string): string {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  return end >= 0 ? html.slice(0, end) : html;
}

/** Meta tags as `name|property|http-equiv` (lower-cased) -> every content value in order. */
export function metaMap(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { attrs } of findTags(html, "meta")) {
    const key = (attrs.name ?? attrs.property ?? attrs["http-equiv"] ?? "").trim().toLowerCase();
    if (!key || attrs.content === undefined) continue;
    const list = out.get(key) ?? [];
    list.push(attrs.content.trim());
    out.set(key, list);
  }
  return out;
}

/** rel tokens, lower-cased: rel="Canonical nofollow" -> ["canonical", "nofollow"]. */
export function relTokens(rel: string | undefined): string[] {
  return (rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The text a reader of the raw HTML gets from <body>: scripts, styles,
 * templates, noscript and inline SVG removed, tags stripped, entities decoded.
 */
export function visibleText(html: string): string {
  const clean = stripComments(html);
  const bodyStart = clean.search(/<body[\s>]/i);
  const body = bodyStart >= 0 ? clean.slice(bodyStart) : clean.slice(Math.max(0, clean.search(/<\/head\s*>/i)));
  return stripTags(
    body
      .replace(/<(script|style|template|noscript|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6]|tr|td|th|section|article)\b[^>]*>/gi, " $&"),
  );
}

export function wordCount(textValue: string): number {
  return textValue.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The <title>, decoded. The first one; a page with several is reported by the caller. */
export function titleOf(html: string): string | null {
  const clean = stripComments(html);
  const t = findElements(headOf(clean), "title")[0] ?? findElements(clean, "title")[0];
  return t ? decode(t.inner) : null;
}

/** Truncate for a table cell. */
export function clip(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Map with a concurrency limit, keeping input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
