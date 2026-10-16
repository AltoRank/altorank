// ---------------------------------------------------------------------------
// How much text the editor's whole-article rewrite may send
// ---------------------------------------------------------------------------
//
// The rewrite (app/api/editor/rewrite/route.ts) takes the text on screen, not
// the saved text, because the person may have typed since the last save. It
// is still sized against the saved article, so a request cannot send any
// amount of text it likes to a long model call.

/** The longest instruction taken: a sentence or a short paragraph. */
export const MAX_INSTRUCTION_CHARS = 2_000;
/** Never more than this, however long the saved article: about 40k tokens. */
export const REWRITE_HARD_CEILING_CHARS = 150_000;
/** What any article may be sent as, however short its saved text. */
export const REWRITE_FLOOR_CHARS = 40_000;

/**
 * The most text a rewrite may send, given the saved article's HTML length:
 * half again plus 10,000 characters of room for what was typed since the last
 * save, never under 40,000 and never over the hard ceiling.
 */
export function rewriteSizeLimit(savedHtmlChars: number): number {
  return Math.min(REWRITE_HARD_CEILING_CHARS, Math.max(REWRITE_FLOOR_CHARS, Math.ceil(savedHtmlChars * 1.5) + 10_000));
}
