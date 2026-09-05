// ---------------------------------------------------------------------------
// HTML helpers shared by the enrichment steps
// ---------------------------------------------------------------------------
//
// Every step in this directory is a pure function over an HTML string. None of
// them may parse with a DOM library: generation runs in a route handler and a
// cron, and the rest of lib/ai already walks tags with regular expressions for
// the same reason. These helpers are the small vocabulary they share, so a
// change to how a section is delimited happens once.

import { stripTags, decode } from "@/lib/audit/html-utils";

export { stripTags, decode };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

/**
 * A heading turned into a portable anchor id.
 *
 * Portable means it survives every CMS this product publishes to: lowercase
 * ASCII, hyphens, nothing a WordPress or Ghost sanitiser would rewrite. Accents
 * are folded rather than dropped so "Perché" becomes "perche", not "perch".
 * Ids must start with a letter to be valid CSS selectors, hence the prefix on
 * a heading that opens with a digit ("5 ways to..." -> "s-5-ways-to").
 */
export function slugify(text: string, maxLength = 64): string {
  const base = stripTags(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, maxLength)
    .replace(/-$/, "");
  if (!base) return "section";
  return /^[a-z]/.test(base) ? base : `s-${base}`;
}

/** `slug`, `slug-2`, `slug-3`... against a set the caller keeps. */
export function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return candidate;
}

export interface Section {
  /** The whole heading element, tag included. */
  heading: string;
  /** Plain text of the heading. */
  headingText: string;
  /** The heading's id attribute, if it has one. */
  id: string | null;
  /** Everything after the heading up to the next H2 (or the end). */
  body: string;
  /** Offsets into the source, so a caller can splice around the section. */
  start: number;
  headingEnd: number;
  end: number;
}

export interface SectionSplit {
  /** Everything before the first H2: the H1, the intro, whatever else. */
  intro: string;
  sections: Section[];
}

const H2_PATTERN = /<h2\b[^>]*>[\s\S]*?<\/h2>/gi;

/**
 * Cut an article at its H2s.
 *
 * H2 is the unit every step works in: a table of contents lists them, an image
 * goes before one, a video belongs to one, a call to action comes after the
 * last. H3s stay inside the body of the H2 that owns them.
 */
export function splitSections(html: string): SectionSplit {
  const matches = [...html.matchAll(H2_PATTERN)];
  if (matches.length === 0) return { intro: html, sections: [] };

  const sections: Section[] = matches.map((m, i) => {
    const start = m.index ?? 0;
    const headingEnd = start + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? html.length) : html.length;
    return {
      heading: m[0],
      headingText: stripTags(m[0]),
      id: attrOf(m[0], "id"),
      body: html.slice(headingEnd, end),
      start,
      headingEnd,
      end,
    };
  });

  return { intro: html.slice(0, sections[0].start), sections };
}

/** Reassemble what `splitSections` cut, after a caller edited pieces of it. */
export function joinSections(intro: string, sections: { heading: string; body: string }[]): string {
  return intro + sections.map((s) => s.heading + s.body).join("");
}

/** The value of one attribute on an opening tag, or null. */
export function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return decode(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Add or replace an attribute on an opening tag. */
export function setAttr(openTag: string, name: string, value: string): string {
  const escaped = escapeAttr(value);
  const existing = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (existing.test(openTag)) {
    return openTag.replace(existing, ` ${name}="${escaped}"`);
  }
  return openTag.replace(/\s*\/?>$/, (end) => ` ${name}="${escaped}"${end.trim()}`);
}

/** Inner HTML of the first `<p>` in a fragment, or null when there is none. */
export function firstParagraph(html: string): { inner: string; start: number; end: number } | null {
  const m = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!m || m.index === undefined) return null;
  return { inner: m[1], start: m.index, end: m.index + m[0].length };
}

/** Plain-text paragraphs of a fragment, in order. */
export function paragraphTexts(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
}

/** Words in a fragment, after tags are dropped. */
export function wordCount(html: string): number {
  const text = stripTags(html);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Split the text of a paragraph into sentences without breaking inside a tag.
 *
 * Works on inner HTML so a caller can wrap one sentence in `<strong>` and put
 * the paragraph back together byte-for-byte. A boundary is a terminal mark
 * followed by whitespace and something that starts a sentence: a capital, a
 * digit, an opening quote or a tag. Abbreviations are not handled; a false
 * split here costs at most a misplaced bold, never lost text.
 */
export function splitSentencesHtml(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inTag = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    buf += ch;
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag && /[.!?]/.test(ch)) {
      const rest = inner.slice(i + 1);
      const m = rest.match(/^(["'”’)]*)(\s+)(?=[A-Z0-9"“‘'<])/);
      if (m) {
        buf += m[1] + m[2];
        i += m[0].length;
        out.push(buf);
        buf = "";
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** First sentence of a plain-text string. */
export function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** Whether the fragment already carries a YouTube embed. */
export function hasVideoEmbed(html: string): boolean {
  return /<iframe\b[^>]*src=["']https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//i.test(html);
}
