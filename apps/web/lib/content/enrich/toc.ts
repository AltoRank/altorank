// ---------------------------------------------------------------------------
// Step 2: table of contents
// ---------------------------------------------------------------------------
//
// A flat list of the H2s, each an in-page anchor, placed after the intro. Flat
// on purpose: the Tiptap converter treats a nested `<ul>` inside an `<li>` as
// the end of the outer list, so H3s would either flatten into the H2 list or
// truncate it. A reader can jump by section; sub-sections are one scroll away.

import { labelsFor } from "./labels";
import { ensureHeadingIds } from "./format";
import { splitSections, escapeHtml } from "./html";

export interface TocOptions {
  /** `workspace_output_settings.table_of_contents`; defaults on. */
  enabled?: boolean;
  /** Fewer H2s than this and a list would be longer than the reading it saves. */
  minSections?: number;
  language?: string | null;
}

export function hasTableOfContents(html: string): boolean {
  if (/<nav\b[^>]*class=["'][^"']*\btoc\b/i.test(html)) return true;
  // Three or more anchors into the page inside one list is a TOC whatever it
  // is called.
  const lists = html.match(/<(?:ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi) ?? [];
  return lists.some((list) => (list.match(/href=["']#[^"']+["']/gi) ?? []).length >= 3);
}

export function addTableOfContents(
  html: string,
  opts: TocOptions = {},
): { html: string; added: boolean } {
  if (opts.enabled === false) return { html, added: false };
  if (hasTableOfContents(html)) return { html, added: false };

  const withIds = ensureHeadingIds(html).html;
  const { intro, sections } = splitSections(withIds);
  const minSections = opts.minSections ?? 3;
  if (sections.length < minSections) return { html, added: false };

  const labels = labelsFor(opts.language);
  const items = sections
    .filter((s) => s.id)
    .map((s) => `<li><a href="#${s.id}">${escapeHtml(s.headingText)}</a></li>`)
    .join("");
  const nav =
    `<nav class="toc" aria-label="${escapeHtml(labels.contents)}">` +
    `<p><strong>${escapeHtml(labels.contents)}</strong></p><ul>${items}</ul></nav>`;

  // After the intro's first paragraph when there is one before the first H2,
  // otherwise directly before the first H2. Never above the H1.
  const h1End = intro.search(/<\/h1>/i);
  const searchFrom = h1End === -1 ? 0 : h1End + 5;
  const firstParagraphEnd = intro.slice(searchFrom).search(/<\/p>/i);
  const insertAt =
    firstParagraphEnd === -1 ? intro.length : searchFrom + firstParagraphEnd + 4;

  const newIntro = intro.slice(0, insertAt) + "\n" + nav + "\n" + intro.slice(insertAt);
  return {
    html: newIntro + sections.map((s) => s.heading + s.body).join(""),
    added: true,
  };
}
