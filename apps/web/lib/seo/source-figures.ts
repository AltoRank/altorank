// ---------------------------------------------------------------------------
// Figures the researched pages state, kept for the writer to cite
// ---------------------------------------------------------------------------
//
// A real signup's first article (2026-09-27, a physiotherapy clinic) had no
// figure at all. The writer had been told never to invent one and "there is
// no minimum number of statistics", and it was given nothing it could cite:
// research fetched the ranking pages to count their words and threw the text
// away. Our own AEO check (`quotableStatistics`) then failed the draft for the
// figures the prompt had talked it out of.
//
// So the pages research already fetches are read once more, in memory, for
// the sentences that state a figure. The writer gets those sentences with
// their URLs and is asked for two or three of them, cited in the sentence;
// with none, it is told there are none and writes none, and the reviewer is
// told why (`figureReviewNote`). No extra request, no model, no paid API: the
// HTML is the one `measureCompetitorLengths` already downloaded.
//
// A figure here is what `findFigures` (lib/seo/aeo-scoring.ts) counts, in the
// research language, so a figure offered is a figure the AEO check sees. A
// language the locale contract does not describe yields none, and the note
// says so.

import { findFigures } from "@/lib/seo/aeo-scoring";
import { resolveLocale, foldCase } from "@/lib/i18n/locale";

export interface SourceFigure {
  /** The sentence as the page states it. */
  sentence: string;
  /** The figures in it, as written. */
  figures: string[];
  url: string;
  domain: string;
}

/** Sentences kept per page, and in all. Enough to choose two or three from. */
export const MAX_PER_PAGE = 3;
export const MAX_FIGURES = 12;
const MIN_SENTENCE = 40;
const MAX_SENTENCE = 280;

/** Page furniture that carries numbers and is never a finding. */
const FURNITURE = /cookie|©|copyright|all rights reserved|subscribe|newsletter|privacy|terms of (?:use|service)|javascript/i;

/** Markdown as plain lines: links to their text, images and markup gone, table rows dropped. */
function plainLines(markdown: string): string[] {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/\n+/)
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*```/.test(l))
    .map((l) => l.replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s+/, "").replace(/[*_`>]+/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * The sentences of one fetched page that state a figure, best first: short
 * enough to quote, long enough to carry what the figure is of.
 */
export function figureSentences(
  markdown: string,
  page: { url: string; domain: string },
  language?: string | null,
): SourceFigure[] {
  const locale = resolveLocale(language);
  if (!locale.supported) return [];
  const out: SourceFigure[] = [];
  const seen = new Set<string>();
  for (const line of plainLines(markdown)) {
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(%$€£₺])/u)) {
      const s = sentence.trim();
      if (s.length < MIN_SENTENCE || s.length > MAX_SENTENCE || FURNITURE.test(s)) continue;
      const figures = [...new Set(findFigures(s, locale.code).map((f) => f.trim()))];
      if (!figures.length) continue;
      const key = foldCase(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sentence: s, figures, url: page.url, domain: page.domain });
      if (out.length >= MAX_PER_PAGE) return out;
    }
  }
  return out;
}

/** The pages' sentences as one list, capped, one sentence per wording. */
export function mergeSourceFigures(perPage: SourceFigure[][]): SourceFigure[] {
  const out: SourceFigure[] = [];
  const seen = new Set<string>();
  // Round-robin, so the first page cannot fill the list on its own.
  for (let i = 0; i < MAX_PER_PAGE; i++) {
    for (const page of perPage) {
      const f = page[i];
      if (!f || seen.has(foldCase(f.sentence))) continue;
      seen.add(foldCase(f.sentence));
      out.push(f);
      if (out.length >= MAX_FIGURES) return out;
    }
  }
  return out;
}

/**
 * What the reviewer is told about the draft's figures, or null when there is
 * nothing to say: the pages offered figures and the draft cites at least two.
 *
 * `offered` is `research.sourceFigures`: undefined when no ranking page could
 * be read (or the draft predates this), empty when the pages were read and
 * stated none.
 */
export function figureReviewNote(
  offered: SourceFigure[] | undefined,
  html: string,
  language?: string | null,
): string | null {
  const text = html.replace(/<[^>]*>/g, " ");
  const locale = resolveLocale(language);
  if (!locale.supported) {
    return `Figures were not looked for in ${locale.name}: the figure rules exist for the supported languages only. Check any figure in this draft by hand.`;
  }
  if (!offered || offered.length === 0) {
    const inDraft = findFigures(text, locale.code).length;
    return (
      (offered ? "The ranking pages research read state no figure this draft could cite" : "No ranking page could be read for figures") +
      (inDraft
        ? `, yet the draft has ${inDraft}; each one needs a source or has to go.`
        : ", so the draft states none and the quotable-statistics check fails on purpose. Add a figure from a source you trust if you have one.")
    );
  }
  const used = offered.filter((o) => o.figures.some((f) => text.includes(f))).length;
  if (used >= 2) return null;
  return `The ranking pages offered ${offered.length} sourced figure${offered.length === 1 ? "" : "s"} and the draft uses ${used}. Two or three, cited in the sentence, is what the brief asked for.`;
}
