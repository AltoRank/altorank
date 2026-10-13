// ---------------------------------------------------------------------------
// Alt text that describes the image, not the keyword
// ---------------------------------------------------------------------------
//
// The alt attribute is the only part of an image a crawler, a screen reader or
// an answer engine can read. The two ways a generated article gets it wrong
// both pass a "has alt text" check and are both worthless: the keyword on its
// own (alt="email marketing software"), which tells a blind reader nothing and
// reads as stuffing to a crawler, and a two-word label ("A chart") that names
// the kind of image and not what is in it.
//
// So the rule is a full descriptive sentence, and the floor is six words: the
// shortest sentence that can carry a subject, a verb and what the image shows.
// The prompt states the rule; this module checks the result. It is pure so the
// audit panel can run it on every keystroke, and it flags rather than rewrites:
// nothing here has seen the image, so nothing here can describe it.

import { decodeEntities } from "@/lib/audit/html-utils";
import { resolveLocale, scaleWords, foldCase, type Locale, type SupportedLocale } from "@/lib/i18n/locale";

/** The floor in English words. Other languages scale it: see `minAltWords`. */
export const MIN_ALT_WORDS = 6;

/**
 * The floor in this language's words. Six English words is about five
 * Turkish ones, because Turkish suffixes carry what English spells as
 * separate words; holding a Turkish alt to six would ask it to say more.
 */
export function minAltWords(locale: SupportedLocale = resolveLocale("en") as SupportedLocale): number {
  return scaleWords(MIN_ALT_WORDS, locale);
}

export type AltTextProblem =
  /** No alt attribute, or an empty one. */
  | "missing"
  /** The keyword and nothing else, with or without "image of" in front. */
  | "keyword"
  /** Fewer than `MIN_ALT_WORDS` words: a label, not a description. */
  | "short";

export interface AltTextFinding {
  src: string;
  alt: string;
  problem: AltTextProblem;
}

/**
 * Lowercase, punctuation gone, whitespace collapsed: what two strings look
 * like when only their words matter. Unicode-aware because the product writes
 * Italian and German alt text as often as English, and folded with
 * `foldCase` so it needs no language: a Turkish "İstanbul" is "istanbul".
 * Plain `toLowerCase` made "İ" an "i" plus a combining dot, the dot became a
 * word break, and "İzmir İş İlanları" counted five words and passed the floor.
 */
function normaliseWords(text: string): string {
  return foldCase(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Openers that dress a keyword up as a description without adding one.
 * "Screenshot of email marketing software" is the keyword with a hat on. The
 * hat is language-dependent ("web tasarımı görseli" wears it at the end), so
 * it comes from the locale contract.
 */
function withoutPictureOf(text: string, locale: Locale): string {
  if (!locale.supported) return text;
  return locale.lower(text).replace(locale.prose.pictureOf, "");
}

export function altWordCount(alt: string): number {
  const words = normaliseWords(alt);
  return words ? words.split(" ").length : 0;
}

/**
 * What is wrong with one alt text, or null when nothing is.
 *
 * Ordered by specificity: an alt that is the keyword alone is also short, and
 * "it repeats the keyword" is the finding a writer can act on.
 *
 * In a language the locale contract does not describe, only the two findings
 * that need no language are made - missing, and the keyword alone. Whether a
 * sentence is long enough, or wrapped in "image of", is not guessed at with
 * English rules.
 */
export function checkAltText(
  alt: string | null | undefined,
  keyword: string,
  language?: string | null,
): AltTextProblem | null {
  const locale = resolveLocale(language);
  const text = (alt ?? "").trim();
  if (!text) return "missing";
  const kw = normaliseWords(keyword);
  if (kw && normaliseWords(withoutPictureOf(text, locale)) === kw) return "keyword";
  if (locale.supported && altWordCount(text) < minAltWords(locale)) return "short";
  return null;
}

function attrValue(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  if (!m) return null;
  // The editor escapes `&` inside attributes; the reviewer should see "Q&A",
  // not "Q&amp;A", when the finding is shown back to them.
  return decodeEntities(m[1] ?? m[2] ?? "");
}

/** Every `<img>` in `html` whose alt text is missing, the keyword alone, or too short to describe anything. */
export function findWeakAltText(html: string, keyword: string, language?: string | null): AltTextFinding[] {
  const out: AltTextFinding[] = [];
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const alt = attrValue(m[1], "alt");
    const problem = checkAltText(alt, keyword, language);
    if (problem) out.push({ src: attrValue(m[1], "src") ?? "", alt: alt ?? "", problem });
  }
  return out;
}
