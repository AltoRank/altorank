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

/**
 * Words of a search too general to say what a sentence is about: "best
 * diaper cream" is about diaper cream, and a sentence with "best" in it is
 * not. Four letters and up only, because shorter words are already ignored.
 */
const GENERIC_TERMS = new Set([
  // English
  "best", "what", "when", "where", "which", "does", "should", "often", "much", "many", "long",
  "your", "with", "from", "that", "this", "about", "there", "need", "make", "guide", "tips",
  "ways", "near", "cheap", "free", "online", "vs", "versus",
  // Italian, Spanish, French, German, Turkish: the question and filler words
  "come", "quanto", "quando", "perché", "migliore", "migliori", "como", "cuánto", "cuando",
  "para", "mejor", "mejores", "comment", "combien", "pour", "avec", "dans", "meilleur",
  "meilleure", "wie", "viel", "wann", "für", "beste", "besten", "nasıl", "nasil", "kadar",
  "için", "icin", "neden", "hangi", "nedir",
]);

/** The words of `topic` that say what it is about, folded, each cut to a stem. */
function topicStems(topic: string): string[] {
  return [...new Set(
    foldCase(topic)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 3 && !GENERIC_TERMS.has(t) && !/^\p{N}+$/u.test(t))
      // A stem, not a word: "diaper" is found in "diapers", "rash" in
      // "rashes", a Turkish noun under its suffixes. Never under four letters.
      .map((t) => t.slice(0, Math.max(4, t.length - 2))),
  )];
}

/**
 * Whether a sentence is about the article's topic: it shares a word stem
 * with the keyword. A figure is evidence only for what its sentence is
 * about, and a page that ranks for a keyword also carries figures about
 * itself. A first draft for a baby-skincare shop (2026-10-21) quoted a
 * consumer magazine's "100% of the fees we collect are used to support our
 * nonprofit mission" in an article about diaper cream: the sentence was the
 * first on that page with a number in it, so research offered it, the
 * writer was asked for two or three figures and used it, and the fact check
 * found the number on the page and called it verified.
 *
 * Deliberately loose: one shared stem is enough, so "zinc oxide cream at
 * 40%" counts for "diaper rash cream". With no topic, or a topic of only
 * short or generic words, every sentence counts: nothing to judge by is not
 * a reason to drop a figure.
 */
export function aboutTopic(sentence: string, topic: string | null | undefined): boolean {
  const stems = topic ? topicStems(topic) : [];
  if (!stems.length) return true;
  const words = foldCase(sentence).split(/[^\p{L}\p{N}]+/u);
  return stems.some((stem) => words.some((w) => w.startsWith(stem)));
}

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
 * enough to quote, long enough to carry what the figure is of, and, with a
 * `topic` (the keyword), about it (`aboutTopic`).
 *
 * Off-topic sentences used to be ranked after the on-topic ones and still
 * fill the list when a page had fewer than three of those. That is how a
 * magazine's "100% of the fees we collect" reached a diaper-cream brief a
 * second time (2026-10-22). A real figure in a sentence that does not name
 * the topic is lost with them; the writer can still use it from the page,
 * and the fact check will not verify it (`figureOnTopic`).
 */
export function figureSentences(
  markdown: string,
  page: { url: string; domain: string },
  language?: string | null,
  topic?: string | null,
): SourceFigure[] {
  const locale = resolveLocale(language);
  if (!locale.supported) return [];
  const out: SourceFigure[] = [];
  const seen = new Set<string>();
  for (const line of plainLines(markdown)) {
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(%$€£₺])/u)) {
      const s = sentence.trim();
      if (s.length < MIN_SENTENCE || s.length > MAX_SENTENCE || FURNITURE.test(s)) continue;
      if (!aboutTopic(s, topic)) continue;
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
