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

export const MIN_ALT_WORDS = 6;

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
 * Italian and German alt text as often as English.
 */
function normaliseWords(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Openers that dress a keyword up as a description without adding one.
 * "Screenshot of email marketing software" is the keyword with a hat on.
 */
const PICTURE_OF =
  /^(?:an?\s+|the\s+)?(?:image|picture|photo|photograph|illustration|graphic|screenshot|diagram|chart|infographic|icon|logo)\s+(?:of|showing|about|for)\s+(?:an?\s+|the\s+)?/i;

export function altWordCount(alt: string): number {
  const words = normaliseWords(alt);
  return words ? words.split(" ").length : 0;
}

/**
 * What is wrong with one alt text, or null when nothing is.
 *
 * Ordered by specificity: an alt that is the keyword alone is also short, and
 * "it repeats the keyword" is the finding a writer can act on.
 */
export function checkAltText(
  alt: string | null | undefined,
  keyword: string,
): AltTextProblem | null {
  const text = (alt ?? "").trim();
  if (!text) return "missing";
  const kw = normaliseWords(keyword);
  if (kw && normaliseWords(text.replace(PICTURE_OF, "")) === kw) return "keyword";
  if (altWordCount(text) < MIN_ALT_WORDS) return "short";
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
export function findWeakAltText(html: string, keyword: string): AltTextFinding[] {
  const out: AltTextFinding[] = [];
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const alt = attrValue(m[1], "alt");
    const problem = checkAltText(alt, keyword);
    if (problem) out.push({ src: attrValue(m[1], "src") ?? "", alt: alt ?? "", problem });
  }
  return out;
}
