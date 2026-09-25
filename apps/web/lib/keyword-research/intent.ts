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
//                  only for a language with a rule set below. Any other
//                  language keeps its words whole and the comparison says
//                  "inflected spellings not compared for <language>".
//
// Synonyms ("şirket"/"firma", "company"/"firm") are only ever caught by the
// results page. There is no synonym list here, on purpose: a hand-kept list
// is wrong in every market it was not written for.

import { LOCALES } from "@/lib/seo/locales";
import { languageCodeOf } from "./locale";

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
 * The language to compare a workspace's keywords in, from `workspaces.language`.
 * The column is NOT NULL; a caller that could not read it gets null, which
 * compares words unfolded and says so, rather than English.
 */
export function intentLanguage(workspaceLanguage: string | null | undefined): string | null {
  return workspaceLanguage?.trim() ? languageCodeOf(workspaceLanguage) : null;
}

/** "tr" from "tr" or "tr-TR", "zh" from "zh-CN"; null when no language was given. */
function primary(language: string | null | undefined): string | null {
  const code = (language ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return code || null;
}

/** "Turkish" for "tr"; the code itself for a language the product has no name for. */
export function languageLabel(language: string | null | undefined): string {
  const code = (language ?? "").trim();
  if (!code) return "an unknown language";
  const entry = Object.values(LOCALES).find((e) => e.languageCode.toLowerCase() === code.toLowerCase())
    ?? Object.values(LOCALES).find((e) => primary(e.languageCode) === primary(code));
  return entry?.label.replace(/\s*\(.*\)$/, "") ?? code;
}

// --- Normalisation -----------------------------------------------------------

/**
 * Lower-case in the language's own rules. `"İ".toLowerCase()` is "i̇" (i plus a
 * combining dot) and `"I".toLowerCase()` is "i" where Turkish wants "ı"; the
 * locale-aware call gets both right. Without a language, the locale-free
 * mapping, never the server's default locale.
 */
function lower(text: string, language: string | null): string {
  if (!language) return text.toLowerCase();
  try {
    return text.toLocaleLowerCase(language);
  } catch {
    // Not a valid BCP 47 tag. Every tag here comes from LOCALES, so this is
    // a caller passing something else; the locale-free mapping is still
    // correct for every language except Turkish and Azeri casing.
    return text.toLowerCase();
  }
}

/** Letters Unicode does not decompose into a base letter plus a mark. */
const UNDECOMPOSED: Record<string, string> = { ı: "i", ø: "o", ł: "l", đ: "d", ß: "ss", æ: "ae", œ: "oe", þ: "th" };

/** "şirket" → "sirket", "geliştirme" → "gelistirme", "ı" → "i": what a searcher without the keyboard types. */
function stripMarks(token: string): string {
  return token
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ıøłđßæœþ]/g, (c) => UNDECOMPOSED[c] ?? c);
}

interface WordRules {
  /** Words that do not change the results page ("for", "and"), in the lower-cased spelling. */
  stopwords: ReadonlySet<string>;
  /** Inflections off one lower-cased token, before diacritics are stripped. */
  fold(token: string): string;
  /** Whole-phrase clean-up before tokenising. */
  prepare?(text: string): string;
}

// English: the rule set that used to be `normalizeTarget` in
// lib/seo/recommendations.ts, unchanged, and now applied to English only.
// Deliberately crude - word order, connecting words and common endings - and
// each fold is here because a live queue planned both halves of it: the cron
// wrote "agency seo" and then "agency for seo" on consecutive firings (see
// lib/seo/__tests__/recommendations.test.ts for the rest).
const ENGLISH: WordRules = {
  stopwords: new Set([
    "a", "an", "the", "for", "and", "or", "of", "to", "in", "on", "with", "is", "are", "my", "your",
    // "website about design" and "website design" are one results page, and
    // a site was given both, and both were scheduled.
    "about",
  ]),
  fold(t) {
    // Plurals.
    let w = t.endsWith("ies") && t.length > 4
      ? `${t.slice(0, -3)}y`
      : t.endsWith("es") && t.length > 4
        ? t.slice(0, -2)
        : t.endsWith("s") && !t.endsWith("ss") && t.length > 3
          ? t.slice(0, -1)
          : t;
    // Agent and verbal-noun endings, after the plural fold so "writers" has
    // already become "writer": "content writing" and "content writer" are one
    // results page, and the queue planned both (2026-09-04). The stem must
    // keep at least four letters, or "user" is "us" and "thing" is "th".
    w = w.endsWith("ing") && w.length > 6 ? w.slice(0, -3) : w.endsWith("er") && w.length > 5 ? w.slice(0, -2) : w;
    // A silent final "e", after the folds above so they have already run:
    // "websites" folded to "websit" while "website" stayed whole, and
    // "creating" to "creat" while "create" stayed whole, so one site kept four
    // calendar slots for two queries.
    return w.endsWith("e") && w.length > 4 ? w.slice(0, -1) : w;
  },
};

// Turkish: an explicit rule set for the two noun inflections that produce
// most spelling variants of one search, and nothing else.
//
//   plural        -lar after a back vowel, -ler after a front one
//                 "firmalar" → "firma", "şirketler" → "şirket"
//   possessive    -sı/-si/-su/-sü after a vowel, -ı/-i/-u/-ü after a
//                 consonant, the vowel following the stem's last vowel
//                 "firması" → "firma", "şirketi" → "şirket"
//
// Applied until nothing more comes off, so "-ları"/"-leri" (plural, then
// possessive) folds too: "firmaları" → "firmalar" → "firma". Guards keep
// bare nouns whole: the stem must keep three letters, and the bare-vowel
// ending only comes off a stem that keeps two syllables, so "kedi", "bilgi"
// and "yazı" stay whole while "kedisi", "bilgisi" and "yazısı" fold to them.
// Consonant alternation ("çocuk"/"çocuğu") and case endings are not folded:
// a missed fold keeps two spellings apart, which the results page then
// settles; a wrong fold would merge two searches, which nothing undoes.
const TR_VOWELS = "aeıioöuü";
const trLastVowel = (s: string): string | null => {
  for (let i = s.length - 1; i >= 0; i--) if (TR_VOWELS.includes(s[i])) return s[i];
  return null;
};
const trSyllables = (s: string): number => [...s].filter((c) => TR_VOWELS.includes(c)).length;
/**
 * Does the ending's vowel follow the stem's last vowel? "i" and "u" also stand
 * in for "ı" and "ü": text typed without Turkish letters writes "firmasi" for
 * "firması", and it is the same search.
 */
function trHarmonises(stem: string, vowel: string): boolean {
  const last = trLastVowel(stem);
  if (!last) return false;
  switch (vowel) {
    case "ı": return "aı".includes(last);
    case "i": return "aıei".includes(last);
    case "u": return "ouöü".includes(last);
    case "ü": return "öü".includes(last);
    default: return false;
  }
}
function trFoldOnce(w: string): string | null {
  if (/l[ae]r$/.test(w)) {
    const stem = w.slice(0, -3);
    const last = trLastVowel(stem);
    if (stem.length >= 3 && last && (w.endsWith("lar") ? "aıou".includes(last) : "eiöü".includes(last))) return stem;
  }
  const vowel = w.at(-1) ?? "";
  if (!"ıiuü".includes(vowel) || !vowel) return null;
  if (w.at(-2) === "s") {
    const stem = w.slice(0, -2);
    if (stem.length >= 3 && TR_VOWELS.includes(stem.at(-1) ?? "") && trHarmonises(stem, vowel)) return stem;
  }
  const stem = w.slice(0, -1);
  if (stem.length >= 3 && !TR_VOWELS.includes(stem.at(-1) ?? "") && trSyllables(stem) >= 2 && trHarmonises(stem, vowel)) return stem;
  return null;
}
const TURKISH: WordRules = {
  // Connectives: "ve" and, "veya" or, "ile" with, "için" for (also typed "icin").
  stopwords: new Set(["ve", "veya", "ile", "için", "icin"]),
  fold(t) {
    let w = t;
    for (let i = 0; i < 4; i++) {
      const next = trFoldOnce(w);
      if (next === null) break;
      w = next;
    }
    return w;
  },
  // A suffix on a name goes after an apostrophe: "Google'ın", "İstanbul'da".
  prepare: (text) => text.replace(/['’‘`´][\p{L}\p{M}]*/gu, ""),
};

const RULES: Record<string, WordRules> = { en: ENGLISH, tr: TURKISH };

/** Whether this language's inflected spellings are folded before words are compared. */
export function foldsInflections(language: string | null | undefined): boolean {
  const code = primary(language);
  return Boolean(code && RULES[code]);
}

/** The sentence a word comparison carries when it could not fold inflections; null when it could. */
export function unfoldedNote(language: string | null | undefined): string | null {
  return foldsInflections(language) ? null : `inflected spellings not compared for ${languageLabel(language)}`;
}

function tokens(term: string, language: string | null): string[] {
  const rules = language ? RULES[primary(language) ?? ""] : undefined;
  let text = lower(term.normalize("NFKC"), language);
  if (rules?.prepare) text = rules.prepare(text);
  return text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/**
 * The words a keyword competes on, as one comparable string: connective words
 * out, inflections folded where the language has a rule set, diacritics
 * stripped, each word once, sorted. "agency for seo" and "seo agencies" are
 * one key in English; "firmaları" and "firması" are one key in Turkish.
 *
 * `language` is the workspace's language code. Null or a language without a
 * rule set keeps the words whole (`unfoldedNote` says so); it is never
 * stemmed as English.
 */
export function intentKey(term: string, language: string | null | undefined): string {
  const code = primary(language);
  const rules = code ? RULES[code] : undefined;
  const words = tokens(term, language?.trim() || null)
    .filter((t) => !rules?.stopwords.has(t))
    .map((t) => stripMarks(rules ? rules.fold(t) : t))
    .filter(Boolean);
  return [...new Set(words)].sort().join(" ");
}

/** The phrase as typed, normalised but not reordered or folded: the identity of one query string. */
function exactKey(term: string, language: string | null): string {
  return tokens(term, language).map(stripMarks).join(" ");
}

// --- Results pages -----------------------------------------------------------

/** host + path, "www." and a trailing slash dropped; null for anything that is not an http(s) URL. */
export function canonicalPage(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
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
function prepare(topic: IntentTopic, language: string | null): Prepared {
  return { key: intentKey(topic.term, language), exact: exactKey(topic.term, language), serp: comparableSerp(topic.organicUrls) };
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
export function sameIntent(a: IntentTopic, b: IntentTopic, language: string | null | undefined): IntentMatch {
  const lang = language?.trim() || null;
  return compare(prepare(a, lang), prepare(b, lang), unfoldedNote(lang));
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
  language: string | null | undefined,
): (topic: IntentTopic) => IntentFollower<T> | null {
  const lang = language?.trim() || null;
  const note = unfoldedNote(lang);
  const prepared = leaders
    .map((topic, index) => ({ topic, index, prepared: prepare(topic, lang) }))
    .sort((a, b) => STAGE_RANK[b.topic.stage] - STAGE_RANK[a.topic.stage] || a.index - b.index);
  return (topic) => {
    const mine = prepare(topic, lang);
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
 * scheduled, then a candidate - and among equals the one given first, so a
 * caller passes candidates in its own ranking. A candidate never displaces
 * something already written or on the calendar.
 */
export function clusterByIntent<T extends StagedTopic>(
  topics: readonly T[],
  language: string | null | undefined,
): Map<T, IntentFollower<T>> {
  const lang = language?.trim() || null;
  const note = unfoldedNote(lang);
  const ordered = topics
    .map((topic, index) => ({ topic, index, prepared: prepare(topic, lang) }))
    .sort((a, b) => STAGE_RANK[b.topic.stage] - STAGE_RANK[a.topic.stage] || a.index - b.index);
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
