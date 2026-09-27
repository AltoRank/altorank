// ---------------------------------------------------------------------------
// One query, one article: when two keywords are the same search
// ---------------------------------------------------------------------------
//
// A real signup (2026-09-22, a Turkish web and mobile agency) had one search
// on its plan three times: "mobil uygulama geliştirme şirketleri" drafted,
// "mobil uygulama geliştirme firmaları" queued for the next day and "mobil
// uygulama geliştirme firması" held for the trial. "şirket" and "firma" are
// synonyms; "-leri", "-ları" and "-sı" are inflections. Two gaps let it
// through. The duplicate checks compared candidates with each other and
// ignored what was already drafted, scheduled or live. And the only
// word-level identity folded English plurals, so "firmaları" and "firması"
// were two words to it, and Turkish was stemmed as if it were English.
//
// This file is the one answer to "are these the same search?". Everything
// that picks or counts topics asks it: the recommender and the nightly pick,
// qualification, the planner, the trial screen's held topics, the top-up, the
// research drawer. Two signals, in this order:
//
//   results page   Qualification buys the top-10 organic results for every
//                  topic it judges and stores them on the keyword
//                  (`opportunity.organicUrls`). When both keywords carry one,
//                  the overlap decides, in any language: Google has already
//                  said whether a synonym or an inflection is the same search
//                  by returning the same pages for it. Nothing new is bought
//                  for this; a keyword without a stored page is compared by
//                  words, and the answer says so.
//   words          Unicode-correct normalisation (NFKC, lower-cased in the
//                  workspace's language so Turkish İ/I/ı/i fold correctly,
//                  diacritics stripped), then the same set of words once
//                  connective words and inflections are removed. Inflections
//                  only for a language with a rule set (`searchWords` in the
//                  locale contract). Any other language keeps its words whole
//                  and the comparison says "inflected spellings not compared
//                  for <language>".
//
// The language, its lowercasing, its word rules and the diacritic fold all
// come from the one locale contract (lib/i18n/locale.ts). Until 2026-09-25
// this file kept its own: its own list of languages, its own Turkish
// lowercasing and mark stripping, and null for "language unknown" where the
// contract says "und". Two registries built the same day can drift, and a
// keyword planner that folds "API" one way while the article checks fold it
// another counts one search as two. A test holds them together.
//
// Synonyms ("şirket"/"firma", "company"/"firm") are only ever caught by the
// results page. There is no synonym list here, on purpose: a hand-kept list
// is wrong in every market it was not written for.

import { foldMarks, resolveLocale, UNKNOWN_LANGUAGE, type Locale, type SearchWordRules } from "@/lib/i18n/locale";

/** Results read per keyword: qualification keeps the top ten organic URLs. */
export const SERP_TOP = 10;

/**
 * Shared top-10 organic URLs at which two keywords are one search.
 *
 * SERP-grouping tools put two queries in one topic at around three or four
 * shared URLs of the ten (SE Ranking's grouper exposes it as a 1-9 slider;
 * several grouping tools default to three, about 40% overlap is the usual
 * rule of thumb). Four, not three, because this decides "one article, park
 * the other" rather than "group under one hub": in a thin local market the
 * same three agency homepages rank for "web design" and "mobile app
 * development" alike, and three shared homepages would merge two services a
 * business sells separately. Four of ten is the point where the two queries
 * are answered by the same results page. A page with fewer than four URLs
 * cannot reach the bar, so such a pair is compared by words instead.
 */
export const SERP_SAME_INTENT_SHARED = 4;

/** How a pair was compared. */
export type IntentBasis = "serp" | "words";

/** A keyword as this file needs it: the phrase, and its results page if one was bought. */
export interface IntentTopic {
  term: string;
  /** Top-10 organic URLs stored at qualification; absent when none was ever bought. */
  organicUrls?: readonly string[] | null;
}

export interface IntentMatch {
  same: boolean;
  basis: IntentBasis;
  /** URLs the two results pages share; set when basis is "serp". */
  shared?: number;
  /** What the word comparison could not do; set when it could not fold inflections. */
  note?: string;
}

/**
 * The language to compare a workspace's keywords in, from `workspaces.language`:
 * the locale contract's code for it ("tr" from "tr", "Turkish" or "tr-TR";
 * "sw" for a code the product has no rules for, which then says "not compared
 * for Swahili" instead of being stemmed as English).
 *
 * The column is NOT NULL, so a missing value means the row could not be read,
 * and that is the contract's one sentinel for it, `UNKNOWN_LANGUAGE` ("und"),
 * as `readWorkspaceLanguage` answers: words compared whole, and the note says
 * the language could not be read. Never English by default.
 */
export function intentLanguage(workspaceLanguage: string | null | undefined): string {
  if (!workspaceLanguage?.trim()) return UNKNOWN_LANGUAGE;
  return resolveLocale(workspaceLanguage).code;
}

/** The word rules for a language, or null when the contract has none for it. */
function searchWords(locale: Locale): SearchWordRules | null {
  return locale.supported ? locale.searchWords : null;
}

// --- Normalisation -----------------------------------------------------------

/** Whether this language's inflected spellings are folded before words are compared. */
export function foldsInflections(language: string): boolean {
  return searchWords(resolveLocale(language)) !== null;
}

/** The sentence a word comparison carries when it could not fold inflections; null when it could. */
export function unfoldedNote(language: string): string | null {
  const locale = resolveLocale(language);
  return searchWords(locale) ? null : `inflected spellings not compared for ${locale.name}`;
}

/**
 * The phrase as words, lowered by the language's own rules (`Locale.lower`:
 * Turkish "İ" is "i" and "I" is "ı", where the locale-free mapping gives
 * "i̇" and "i"). Inflection rules read the language's own letters, so the
 * dotless ı is still itself here; `foldMarks` folds it afterwards.
 */
function tokens(term: string, locale: Locale): string[] {
  const rules = searchWords(locale);
  let text = locale.lower(term.normalize("NFKC"));
  if (rules?.prepare) text = rules.prepare(text);
  return text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/**
 * The words a keyword competes on, as one comparable string: connective words
 * out, inflections folded where the language has a rule set, diacritics
 * stripped, each word once, sorted. "agency for seo" and "seo agencies" are
 * one key in English; "firmaları" and "firması" are one key in Turkish.
 *
 * `language` is the workspace's language code (`intentLanguage`). A language
 * without a rule set, and `UNKNOWN_LANGUAGE`, keep the words whole
 * (`unfoldedNote` says so); they are never stemmed as English.
 */
export function intentKey(term: string, language: string): string {
  return keyIn(term, resolveLocale(language));
}

function keyIn(term: string, locale: Locale): string {
  const rules = searchWords(locale);
  const all = tokens(term, locale);
  const side = (words: string[]) => [...new Set(words
    .filter((t) => !rules?.stopwords.has(t))
    .map((t) => foldMarks(rules ? rules.fold(t) : t))
    .filter(Boolean))].sort().join(" ");
  // The last direction word with words on both sides splits the phrase:
  // "how to convert java to python" is "convert how java" > "python".
  let at = -1;
  for (let i = all.length - 2; i > 0 && rules?.directional; i--) {
    if (rules.directional.has(all[i])) { at = i; break; }
  }
  if (at > 0) {
    const before = side(all.slice(0, at));
    const after = side(all.slice(at + 1));
    if (before && after) return `${before} > ${after}`;
  }
  return side(all);
}

/** The phrase as typed, normalised but not reordered or folded: the identity of one query string. */
function exactKey(term: string, locale: Locale): string {
  return tokens(term, locale).map(foldMarks).join(" ");
}

// --- Results pages -----------------------------------------------------------

/**
 * Query parameters that say who clicked or from where, not which page. Google
 * adds `srsltid` to organic results itself, per query, so two results pages
 * holding the same page would otherwise hold two different URLs.
 */
const TRACKING_PARAM = /^(?:utm_.*|srsltid|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|ref|ref_src)$/i;

/**
 * host + path + the query parameters that pick the page, "www." and a trailing
 * slash dropped; null for anything that is not an http(s) URL. The query is
 * kept because some paths name no page on their own: every YouTube result is
 * youtube.com/watch, and without `?v=` any two results pages that each hold a
 * video would share a "page".
 */
export function canonicalPage(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    const params = [...url.searchParams].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${query}`;
  } catch { return null; }
}

/** The top-10 URLs stored on a keyword's verdict, whatever that verdict's age or context. */
export function storedSerp(opportunity: unknown): string[] | null {
  const urls = (opportunity as { organicUrls?: unknown } | null | undefined)?.organicUrls;
  if (!Array.isArray(urls)) return null;
  const clean = urls.filter((u): u is string => typeof u === "string");
  return clean.length ? clean : null;
}

/** The canonical top-10 set, or null when it is too thin to reach the bar. */
function comparableSerp(urls: readonly string[] | null | undefined): Set<string> | null {
  if (!urls?.length) return null;
  const set = new Set(urls.slice(0, SERP_TOP).map(canonicalPage).filter((u): u is string => Boolean(u)));
  return set.size >= SERP_SAME_INTENT_SHARED ? set : null;
}

/** How many top-10 URLs two results pages share. */
export function sharedResults(a: readonly string[], b: readonly string[]): number {
  const right = new Set(b.slice(0, SERP_TOP).map(canonicalPage).filter(Boolean));
  return new Set(a.slice(0, SERP_TOP).map(canonicalPage).filter((u) => u && right.has(u))).size;
}

// --- The comparison ----------------------------------------------------------

interface Prepared { key: string; exact: string; serp: Set<string> | null }
function prepare(topic: IntentTopic, locale: Locale): Prepared {
  return { key: keyIn(topic.term, locale), exact: exactKey(topic.term, locale), serp: comparableSerp(topic.organicUrls) };
}
function compare(a: Prepared, b: Prepared, note: string | null): IntentMatch {
  // One query typed twice is one search, whatever two results pages bought
  // weeks apart say.
  if (a.exact && a.exact === b.exact) return { same: true, basis: "words" };
  if (a.serp && b.serp) {
    let shared = 0;
    for (const url of a.serp) if (b.serp.has(url)) shared++;
    return { same: shared >= SERP_SAME_INTENT_SHARED, basis: "serp", shared };
  }
  return { same: Boolean(a.key) && a.key === b.key, basis: "words", ...(note ? { note } : {}) };
}

/**
 * Are these two keywords one search? The results pages decide when both were
 * bought; the words decide otherwise, and a words answer in a language
 * without a rule set carries `note`.
 */
export function sameIntent(a: IntentTopic, b: IntentTopic, language: string): IntentMatch {
  const locale = resolveLocale(language);
  return compare(prepare(a, locale), prepare(b, locale), unfoldedNote(language));
}

/** In words, for a reason line: "the same 6 of the top 10 results", "the same words". */
export function describeMatch(match: IntentMatch): string {
  if (match.basis === "serp") return `the same ${match.shared} of the top ${SERP_TOP} results`;
  return match.note ? `the same words (${match.note})` : "the same words";
}

// --- Clusters ----------------------------------------------------------------

/** How far a topic has gone. A topic further along leads its cluster. */
export type IntentStage = "live" | "drafted" | "scheduled" | "candidate";
const STAGE_RANK: Record<IntentStage, number> = { live: 3, drafted: 2, scheduled: 1, candidate: 0 };

export interface StagedTopic extends IntentTopic {
  stage: IntentStage;
  /**
   * Its calendar date (YYYY-MM-DD), for a topic on the calendar. Between two
   * of one stage the earlier date leads: two scheduled phrasings of one
   * search keep the entry due first, not one weeks out.
   */
  date?: string | null;
}

/** Leader order: furthest along, then the earliest calendar date, then the caller's order. */
function leadOrder(a: { topic: StagedTopic; index: number }, b: { topic: StagedTopic; index: number }): number {
  const da = a.topic.date || "9999-99-99";
  const db = b.topic.date || "9999-99-99";
  return STAGE_RANK[b.topic.stage] - STAGE_RANK[a.topic.stage] || (da < db ? -1 : da > db ? 1 : 0) || a.index - b.index;
}

export interface IntentFollower<T> {
  leader: T;
  match: IntentMatch;
}

/**
 * The topic, among `leaders`, that already owns this one's search - the one
 * furthest along when several do - or null. For a caller comparing a batch of
 * new topics against what is already live, drafted or scheduled, without
 * ranking the new ones against each other.
 */
export function intentMatcher<T extends StagedTopic>(
  leaders: readonly T[],
  language: string,
): (topic: IntentTopic) => IntentFollower<T> | null {
  const locale = resolveLocale(language);
  const note = unfoldedNote(language);
  const prepared = leaders
    .map((topic, index) => ({ topic, index, prepared: prepare(topic, locale) }))
    .sort(leadOrder);
  return (topic) => {
    const mine = prepare(topic, locale);
    for (const leader of prepared) {
      const match = compare(mine, leader.prepared, note);
      if (match.same) return { leader: leader.topic, match };
    }
    return null;
  };
}

/**
 * One article per search. Groups topics into clusters and returns every topic
 * that is NOT its cluster's leader, with the leader and the comparison that
 * joined them; a topic absent from the map leads its own cluster.
 *
 * The leader is the topic furthest along - live, then drafted, then
 * scheduled, then a candidate - then the one due first on the calendar, and
 * among equals the one given first, so a caller passes candidates in its own
 * ranking. A candidate never displaces something already written or on the
 * calendar, so a caller passes as "scheduled" only what will still be written
 * (lib/keyword-research/intent-leaders.ts).
 */
export function clusterByIntent<T extends StagedTopic>(
  topics: readonly T[],
  language: string,
): Map<T, IntentFollower<T>> {
  const locale = resolveLocale(language);
  const note = unfoldedNote(language);
  const ordered = topics
    .map((topic, index) => ({ topic, index, prepared: prepare(topic, locale) }))
    .sort(leadOrder);
  const leaders: typeof ordered = [];
  const followers = new Map<T, IntentFollower<T>>();
  for (const item of ordered) {
    let joined = false;
    for (const leader of leaders) {
      const match = compare(item.prepared, leader.prepared, note);
      if (match.same) {
        followers.set(item.topic, { leader: leader.topic, match });
        joined = true;
        break;
      }
    }
    if (!joined) leaders.push(item);
  }
  return followers;
}
