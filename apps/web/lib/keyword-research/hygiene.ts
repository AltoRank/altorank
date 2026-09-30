// ---------------------------------------------------------------------------
// Candidate hygiene: what a rival's pool may hand the paid judges
// ---------------------------------------------------------------------------
//
// A rival's ranked keywords are the top of everything it ranks for, across
// its whole domain. For a competitor in the same trade that is the market.
// For a giant general site it is the internet: a small agency's re-run read a
// software giant as a search rival and stored its consumer head terms (a
// translator, games, streaming, webmail) - 217 of 260 rows, every one of them
// bought, judged and refused (assessment 2026-09-29).
//
// Two rules, both free, both applied before any model is asked:
//
//   general rival   a known platform (`GENERAL_SITES`), or a rival whose pool
//                   is mostly off-profile: more than half of its rows share no
//                   word with the business's vocabulary (`GENERAL_SHARE`, over
//                   at least `GENERAL_MIN_ROWS` rows). All its rows are dropped.
//   off profile     a single rival row that shares no word with the business's
//                   vocabulary. Dropped.
//
// The vocabulary is the business profile (name, what it does, offerings,
// audiences, buying jobs), the buyer seeds discovery proposed in the market's
// language, and the site's own crawled terms: a profile written in English
// for a Turkish market still meets its buyers' words through the seeds and
// the site. A word matches on its stem, so an inflection or a Turkish suffix
// is still the same word. Both drops are counted, by stage, in the run's
// funnel (lib/keyword-research/topic-funnel.ts).

import { foldCase } from "@/lib/i18n/locale";

/**
 * Platforms whose pool is the internet, never a small business's rival. A
 * stated list, applied before their rows are bought; the share rule below
 * catches the ones not on it.
 */
export const GENERAL_SITES: readonly string[] = [
  "microsoft.com", "google.com", "apple.com", "amazon.com", "facebook.com", "meta.com", "instagram.com", "youtube.com",
  "wikipedia.org", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "pinterest.com", "reddit.com", "yahoo.com",
  "bing.com", "adobe.com", "canva.com", "netflix.com", "spotify.com", "github.com", "medium.com", "wordpress.com",
  "wix.com", "shopify.com", "ebay.com", "aliexpress.com", "booking.com", "tripadvisor.com", "yandex.com", "yandex.com.tr",
  "trendyol.com", "hepsiburada.com", "sahibinden.com", "n11.com", "amazon.it", "amazon.com.tr",
];
/** A pool with more than this share of off-profile rows is a general site's, not a rival's. */
export const GENERAL_SHARE = 0.5;
/** Rows a pool needs before its share is read: a handful of rows is not a pattern. */
export const GENERAL_MIN_ROWS = 10;

/** Words that say nothing about a subject, in the markets the product serves. */
const FUNCTION_WORDS = new Set([
  "and", "the", "for", "with", "from", "your", "you", "our", "how", "what", "why", "when", "who", "which", "best", "top", "near", "free", "online",
  "cheap", "new", "services", "service", "company", "companies", "near", "about", "into", "all", "any",
  "ile", "icin", "ve", "bir", "bu", "en", "iyi", "nedir", "nasil", "neden", "hangi", "fiyat", "fiyatlari", "firma", "firmalari", "hizmet", "hizmetleri",
  "con", "per", "del", "della", "delle", "dei", "degli", "che", "come", "cosa", "quale", "quali", "migliori", "migliore", "prezzo", "prezzi", "costo", "costi",
  "the", "und", "der", "die", "das", "fur", "mit", "les", "des", "pour", "avec", "los", "las", "para", "por",
]);

/** The words of a text, folded, subject words only. */
export function subjectWords(text: string): string[] {
  return foldCase(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Same word, on its stem: "clinics"/"clinic", "yazılımı"/"yazılım", "fattura"/"fatture". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const stem = (w: string) => w.slice(0, Math.max(4, w.length - 3));
  return (a.length >= 4 && b.startsWith(stem(a))) || (b.length >= 4 && a.startsWith(stem(b)));
}

export interface VocabularySource {
  name?: string | null;
  description?: string | null;
  offerings?: readonly string[] | null;
  audiences?: readonly string[] | null;
  buyingJobs?: readonly string[] | null;
}

/** The business's vocabulary: profile, buyer seeds, crawled terms. */
export function profileVocabulary(business: VocabularySource | null | undefined, extra: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (text: string | null | undefined) => { for (const w of subjectWords(text ?? "")) out.add(w); };
  add(business?.name);
  add(business?.description);
  for (const list of [business?.offerings, business?.audiences, business?.buyingJobs]) for (const t of list ?? []) add(t);
  for (const t of extra) add(t);
  return out;
}

/** Whether a phrase shares at least one subject word with the vocabulary. */
export function sharesVocabulary(term: string, vocabulary: ReadonlySet<string>): boolean {
  const words = subjectWords(term);
  if (!words.length) return false;
  for (const w of words) {
    if (vocabulary.has(w)) return true;
    for (const v of vocabulary) if (sameWord(w, v)) return true;
  }
  return false;
}

const bareHost = (h: string) => h.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** A platform on the stated list, or a subdomain of one. */
export function isGeneralSite(host: string): boolean {
  const h = bareHost(host);
  return GENERAL_SITES.some((g) => h === g || h.endsWith(`.${g}`));
}

/** Whether a rival's pool is mostly off-profile: a general site's, not a competitor's. */
export function isGeneralPool(terms: readonly string[], vocabulary: ReadonlySet<string>): boolean {
  if (terms.length < GENERAL_MIN_ROWS || !vocabulary.size) return false;
  const off = terms.filter((t) => !sharesVocabulary(t, vocabulary)).length;
  return off > terms.length * GENERAL_SHARE;
}

/** What hygiene set aside in one discovery, for the run's funnel and the keywords line. */
export interface Screened {
  /** Distinct phrases from general rivals, dropped with their rival. */
  generalRival: number;
  /** Distinct rival phrases that share no word with the business. */
  offProfile: number;
  /** The rivals dropped as general sites. */
  generalRivals: string[];
}
