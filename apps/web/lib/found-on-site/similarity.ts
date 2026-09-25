// ---------------------------------------------------------------------------
// Is this page our draft? Text containment, in any language
// ---------------------------------------------------------------------------
//
// A real signup (2026-09-22, a Turkish web/mobile agency) published one of our
// drafts on their own hand-coded site 48 minutes after it was written: about
// 82-92% of our words, in our order, after fixing a few lines. Nothing in
// AltoRank noticed, so every metric counted them as never having used a draft.
//
// The question here is narrow: does page P carry draft D's text? Not "is P
// about the same thing" - a competitor's article on the same keyword, written
// to the same outline, is about the same thing and is not our draft. So the
// measure is word-shingle containment: the share of D's runs of SHINGLE
// consecutive words that also occur somewhere in P.
//
//   containment(D in P) = |shingles(D) ∩ shingles(P)| / |shingles(D)|
//
// Containment, not Jaccard, because P is bigger than D by construction: the
// site's navigation, footer, cookie banner and related-posts block are all on
// the page, and none of them should dilute a copy. Runs of words, not single
// words, because two articles on one topic share most of their vocabulary and
// almost none of their sentences.
//
// Language-agnostic on purpose. Words come from `Intl.Segmenter` (Unicode word
// boundaries, with ICU's dictionaries for scripts written without spaces),
// then fold case and diacritics the same way on both sides: NFKD, marks
// dropped, lower-cased, dotless ı folded to i. So a copy that lost its Turkish
// characters on the way through somebody's editor ("İstanbul'da" typed as
// "Istanbulda") still lines up, and nothing here knows or guesses what
// language either text is in.
//
// The thresholds are set by the fixtures in __tests__/similarity.test.ts, not
// by feel: a lightly edited copy (about 80% of the words kept in order,
// headings translated, the call to action replaced) must match, and a
// different article on the same topic with the same outline and different
// prose must not. The title is supporting evidence only - the same-outline
// fixture has an identical title and must still fail.

import { decodeEntities } from "@/lib/audit/html-utils";

/** Words per shingle. See the fixture table in the test for why four. */
export const SHINGLE = 4;

/**
 * Containment at or above this is a copy on its own. The same-outline fixtures
 * sit far below it; the lightly edited copies sit far above.
 *
 * A known limit, pinned in the test: this holds for edits made the way people
 * edit - a sentence reworded here, a paragraph cut there, the rest untouched.
 * Edits spread evenly through the text break every run of four words they
 * touch, so the same 80% of words kept in order scores far lower when the
 * changed word is every fifth one (about 0.2, no match) than when the changes
 * come in clumps (above 0.65). One changed word in six still matches under
 * our headline (about 0.33, the text+title rule); one in eight matches on the
 * text alone. An evenly respun copy is not found. Catching it would take
 * shorter runs, which is where two articles on one topic start to share
 * stock phrases (the table in the test), so the limit is kept and stated.
 */
export const CONTAINMENT_MATCH = 0.5;

/**
 * Between this and CONTAINMENT_MATCH, a copy only when the title agrees too:
 * a heavier edit of our draft published under our headline.
 */
export const CONTAINMENT_WITH_TITLE = 0.3;
export const TITLE_MATCH = 0.6;

/**
 * A draft shorter than this many shingles is not compared at all. A few
 * dozen words can occur on any page in the niche, and "we found your article"
 * on that evidence would be a guess dressed as a measurement.
 */
export const MIN_DRAFT_SHINGLES = 40;

/** Text past this is not read. A copy of a 3,000-word draft fits many times over. */
const MAX_TEXT_CHARS = 200_000;

const BLOCK_TAGS =
  /<\/?(p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|thead|tbody|tfoot|section|article|header|footer|nav|main|aside|blockquote|pre|figure|figcaption|details|summary|form|fieldset|address|caption)\b[^>]*>/gi;

/**
 * The text of an HTML fragment or page, for comparison only.
 *
 * Block-level tags become spaces and inline tags vanish, so a word split by a
 * link or a bold run ("<a>İstanbul</a>'da") reads as one word, the same as it
 * does in a copy whose links were lost. Scripts, styles and the like are
 * dropped with their contents.
 */
export function comparisonText(html: string): string {
  const cleaned = html
    .slice(0, MAX_TEXT_CHARS * 4)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript|svg|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(BLOCK_TAGS, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(cleaned).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

/**
 * One word, folded so the same word compares equal however it was typed:
 * compatibility-decomposed, combining marks dropped, lower-cased, dotless i
 * folded, and anything that is not a letter or a digit removed (so the
 * apostrophe in "don't" or in a Turkish suffix, straight or curly, does not
 * split or distinguish a word).
 */
export function foldWord(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

let segmenter: Intl.Segmenter | null = null;

/** The words of a text, in order, folded. Punctuation and whitespace are not words. */
export function wordsOf(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const out: string[] = [];
  for (const seg of segmenter.segment(text.slice(0, MAX_TEXT_CHARS))) {
    if (!seg.isWordLike) continue;
    const w = foldWord(seg.segment);
    if (w) out.push(w);
  }
  return out;
}

/** Every run of `k` consecutive words, as a set. */
export function shinglesOf(words: readonly string[], k: number = SHINGLE): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(" "));
  return out;
}

/** Share of `inner`'s shingles that also occur in `outer`. 0 when `inner` has none. */
export function containment(inner: ReadonlySet<string>, outer: ReadonlySet<string>): number {
  if (inner.size === 0) return 0;
  let shared = 0;
  for (const s of inner) if (outer.has(s)) shared++;
  return shared / inner.size;
}

/**
 * How alike two headlines are: Sørensen-Dice over their folded word sets.
 * 1 for the same words in any order, 0 for none in common, 0 when either is
 * missing - an absent title is not evidence either way.
 */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = new Set(wordsOf(a ?? ""));
  const B = new Set(wordsOf(b ?? ""));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** A draft, prepared once and compared with every candidate page. */
export interface PreparedDraft {
  title: string;
  shingles: Set<string>;
  words: number;
}

export function prepareDraft(title: string, bodyHtml: string): PreparedDraft {
  const words = wordsOf(comparisonText(bodyHtml));
  return { title, shingles: shinglesOf(words), words: words.length };
}

/** A fetched page, prepared once. `titles` is every headline the page offers: og:title, <title>, H1. */
export interface PreparedPage {
  titles: string[];
  shingles: Set<string>;
  words: number;
}

export function preparePage(html: string, titles: Array<string | null | undefined>): PreparedPage {
  const words = wordsOf(comparisonText(html));
  return {
    titles: titles.filter((t): t is string => Boolean(t && t.trim())),
    shingles: shinglesOf(words),
    words: words.length,
  };
}

/** What a comparison measured. Stored on the article, so the product can show its working. */
export interface MatchEvidence {
  /** Share of the draft's word runs found on the page, 0-1. */
  containment: number;
  /** Best headline similarity between the draft title and any page headline, 0-1. */
  title: number;
  /** The draft's word runs, the denominator of `containment`. */
  draftShingles: number;
  /** Which rule decided: text alone, text plus title, or neither. */
  rule: "text" | "text+title" | "none" | "too-short";
}

export function compare(draft: PreparedDraft, page: PreparedPage): MatchEvidence {
  const title = Math.max(0, ...page.titles.map((t) => titleSimilarity(draft.title, t)));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (draft.shingles.size < MIN_DRAFT_SHINGLES) {
    return { containment: 0, title: round(title), draftShingles: draft.shingles.size, rule: "too-short" };
  }
  const c = containment(draft.shingles, page.shingles);
  const rule: MatchEvidence["rule"] =
    c >= CONTAINMENT_MATCH ? "text" : c >= CONTAINMENT_WITH_TITLE && title >= TITLE_MATCH ? "text+title" : "none";
  return { containment: round(c), title: round(title), draftShingles: draft.shingles.size, rule };
}

export function isMatch(e: Pick<MatchEvidence, "rule">): boolean {
  return e.rule === "text" || e.rule === "text+title";
}
