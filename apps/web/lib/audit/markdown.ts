/**
 * HTML to Markdown, and llms.txt, for sites we do not control.
 *
 * `apps/marketing/scripts/generate-agent-files.mjs` does this for AltoRank's
 * own site at build time. It can assume a lot: it reads the built `dist/`, it
 * knows the sitemap is already on disk, and it strips chrome via
 * `data-print-hide`, a marker we put there ourselves.
 *
 * None of that holds for a client's WordPress or Shopify site. This module is
 * the general case: pure functions over an HTML string, no filesystem, no build
 * output, no cooperation from the page. It is the version that lifts into
 * packages/core as `core/src/ai/markdown.ts` on the pivot plan's Phase 1
 * critical path; the marketing script should collapse onto it once there is a
 * shared package to import from (tracked in memory/open-loops.md).
 *
 * The hard part is deciding what on the page is content. We prefer explicit
 * semantics (`<main>`, `<article>`) and fall back to body-minus-chrome, and we
 * always report which strategy was used so a caller can decide how much to
 * trust the output rather than assuming it is clean.
 */

import { decode, decodeEntities, absoluteUrl } from "./html-utils";

export type ContentSource = "main" | "article" | "body-minus-chrome";

export interface ExtractedContent {
  html: string;
  /** How the content boundary was decided. `body-minus-chrome` is the guess. */
  source: ContentSource;
  /** True when the page offered no semantic landmark, so extraction is heuristic. */
  heuristic: boolean;
}

export interface MarkdownResult {
  markdown: string;
  title?: string;
  source: ContentSource;
  heuristic: boolean;
  /** Rough word count of the extracted content, for sanity-checking output. */
  words: number;
}

// Removed entirely: no textual content, and <form>/<dialog> are interaction
// surfaces whose labels read as nonsense prose once tags are stripped.
const DROP = /<(script|style|svg|noscript|iframe|template|form|dialog|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SELF_CLOSING_DROP = /<(input|source|track)\b[^>]*\/?>/gi;

/** Landmark elements that are chrome on essentially every site. */
const CHROME_TAGS = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * ARIA landmarks and the class-name vocabulary that cookie banners, menus and
 * sidebars converge on. Matched on the opening tag only; the element is then
 * removed with its subtree by `dropElement`.
 */
// No trailing \b: these alternatives end in a quote, and `"` followed by `>`
// is two non-word characters, so a word boundary can never match there. That
// silently disabled the whole role=/aria-hidden= branch.
const CHROME_ATTR =
  /\b(?:role=["'](?:navigation|banner|contentinfo|complementary|search|dialog)["']|aria-hidden=["']true["']|data-print-hide\b)/i;
const CHROME_CLASS =
  /\b(?:class|id)=["'][^"']*\b(?:cookie|consent|gdpr|banner|navbar|nav-|menu|sidebar|breadcrumb|skip-link|social-share|newsletter|popup|modal|offcanvas|site-header|site-footer)\b[^"']*["']/i;

const CHROME_CANDIDATE = /<(div|section|ul|ol|aside|header|footer|nav)\b([^>]*)>/gi;

/**
 * Remove an element and its subtree, counting nested open/close tags.
 *
 * A plain regex cannot do this: `<div class="menu">...<div>...</div>...</div>`
 * matches to the first `</div>` and leaves a dangling tail. Depth counting is
 * the minimum correct approach short of a real parser.
 */
function dropElement(html: string, tagName: string, startIndex: number): string {
  const rest = html.slice(startIndex);
  const tags = new RegExp(`<(/)?${tagName}\\b[^>]*>`, "gi");
  let depth = 0;

  for (const m of rest.matchAll(tags)) {
    if (m[1]) {
      depth--;
      if (depth <= 0) {
        return html.slice(0, startIndex) + rest.slice((m.index ?? 0) + m[0].length);
      }
    } else {
      depth++;
    }
  }
  // Unclosed element: drop the remainder rather than keep a broken subtree.
  return html.slice(0, startIndex);
}

/** Strip elements whose opening tag matches a chrome signature. */
function stripChromeByAttribute(html: string): string {
  let out = html;

  // Re-scan after each removal: indices shift, and chrome nests.
  for (let guard = 0; guard < 500; guard++) {
    const hit = [...out.matchAll(CHROME_CANDIDATE)].find(
      (m) => CHROME_ATTR.test(m[2]) || CHROME_CLASS.test(m[2]),
    );
    if (!hit) break;
    out = dropElement(out, hit[1], hit.index ?? 0);
  }
  return out;
}

/**
 * Isolate the content of a page.
 *
 * Order matters: an explicit landmark beats any heuristic, because a site that
 * marked up `<main>` has told us where its content is and guessing over the top
 * of that would be worse.
 */
export function extractMainContent(html: string): ExtractedContent {
  let s = html.replace(DROP, "").replace(SELF_CLOSING_DROP, "").replace(/<!--[\s\S]*?-->/g, "");

  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main && main[1].trim().length > 200) {
    return { html: stripChromeByAttribute(main[1]), source: "main", heuristic: false };
  }

  // Longest <article> wins: listing pages carry many stubs plus one real body.
  const articles = [...s.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  if (articles.length) {
    const longest = articles.reduce((a, b) => (a.length >= b.length ? a : b));
    if (longest.trim().length > 200) {
      return { html: stripChromeByAttribute(longest), source: "article", heuristic: false };
    }
  }

  s = s.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s;
  s = s.replace(CHROME_TAGS, "");
  return { html: stripChromeByAttribute(s), source: "body-minus-chrome", heuristic: true };
}

// ── inline + block conversion ────────────────────────────────────────────────

/**
 * Convert inline markup to Markdown.
 *
 * Uses `decodeEntities`, not `decode`: this runs over the whole document on the
 * final pass, and `decode` collapses `\s+`, which would eat the newlines that
 * separate every block from the next.
 */
function inline(s: string, baseUrl: string): string {
  return decodeEntities(
    s
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) =>
        t.trim() ? `**${t.replace(/<[^>]+>/g, "").trim()}**` : "")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t: string) =>
        t.trim() ? `*${t.replace(/<[^>]+>/g, "").trim()}*` : "")
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) =>
        `\`${t.replace(/<[^>]+>/g, "").trim()}\``)
      .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
        const text = t.replace(/<[^>]+>/g, "").trim();
        if (!text) return "";
        if (href.startsWith("#") || href.startsWith("javascript:")) return text;
        const url = absoluteUrl(href, baseUrl);
        return url ? `[${text}](${url})` : text;
      })
      // Alt text is the only part of an image an agent can read.
      .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_, alt: string) => `![${alt}]`)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    // Collapse runs of spaces and tabs only, so block newlines survive.
    .replace(/[^\S\n]+/g, " ");
}

/**
 * Convert a full HTML document to Markdown.
 *
 * Block elements are handled outermost-first so nested inline markup survives,
 * and a soft newline is inserted at every block close before tags are stripped.
 * Without that, sibling cards built from unsemantic nested divs concatenate into
 * one unreadable run, which is the common shape of a modern marketing page.
 */
export function htmlToMarkdown(html: string, baseUrl: string): MarkdownResult {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || undefined;
  const extracted = extractMainContent(html);
  let s = extracted.html;

  s = s.replace(/<\/(div|section|article|li|tr|details|p|h[1-6])>/gi, "\n$&");

  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t: string) =>
    `\n\n\`\`\`\n${decode(t.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);

  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, table: string) => {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((m) => [...m[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2], baseUrl)))
      .filter((r) => r.length);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
    const body = rows.map((r) => `| ${pad(r).join(" | ")} |`);
    body.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return `\n\n${body.join("\n")}\n\n`;
  });

  s = s.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag: string, t: string) => {
    const text = inline(t, baseUrl);
    return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => {
    const text = inline(t, baseUrl);
    return text ? `\n- ${text}` : "";
  });
  s = s.replace(/<(p|summary|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag: string, t: string) => {
    const text = inline(t, baseUrl);
    if (!text) return "";
    return tag.toLowerCase() === "blockquote" ? `\n\n> ${text}\n\n` : `\n\n${text}\n\n`;
  });

  const markdown = inline(s, baseUrl)
    .split("\n")
    .map((line) => line.trimEnd())
    // Source HTML is deeply indented; leading whitespace would turn ordinary
    // lines into accidental code blocks.
    .map((line) => (line.startsWith("- ") ? line : line.trimStart()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    markdown: markdown ? markdown + "\n" : "",
    title,
    source: extracted.source,
    heuristic: extracted.heuristic,
    words: markdown ? markdown.split(/\s+/).filter(Boolean).length : 0,
  };
}

// ── llms.txt ──────────────────────────────────────────────────────────────────

export interface LlmsTxtPage {
  url: string;
  title: string;
  description?: string;
  /** Optional grouping heading. Pages with no section land under "Other". */
  section?: string;
}

export interface LlmsTxtInput {
  siteName: string;
  /** One-paragraph summary, rendered as the blockquote llmstxt.org expects. */
  summary?: string;
  /** Plain paragraphs after the summary, e.g. status or scope caveats. */
  notes?: string[];
  pages: LlmsTxtPage[];
}

/**
 * Render an llms.txt per the llmstxt.org convention.
 *
 * Built from pages that were actually found, never from a hand-written list: a
 * stale index pointing at routes that no longer exist is worse than none, and
 * on a client's site it is a claim that stops being true silently.
 */
export function buildLlmsTxt({ siteName, summary, notes = [], pages }: LlmsTxtInput): string {
  const lines: string[] = [`# ${siteName}`, ""];

  if (summary) {
    for (const line of summary.split("\n")) lines.push(`> ${line.trim()}`);
    lines.push("");
  }
  for (const note of notes) lines.push(note, "");

  const sections = new Map<string, LlmsTxtPage[]>();
  for (const page of pages) {
    const key = page.section ?? "Other";
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(page);
  }
  // "Other" always sorts last; it is the leftovers bucket.
  const ordered = [...sections.entries()].sort(([a], [b]) =>
    a === "Other" ? 1 : b === "Other" ? -1 : 0);

  for (const [section, items] of ordered) {
    lines.push(`## ${section}`, "");
    for (const p of items) {
      lines.push(p.description ? `- [${p.title}](${p.url}): ${p.description}` : `- [${p.title}](${p.url})`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
