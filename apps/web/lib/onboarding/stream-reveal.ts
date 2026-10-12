// ---------------------------------------------------------------------------
// The first article's text, revealed as if it were being typed
// ---------------------------------------------------------------------------
//
// The gate's reader used to set the whole body it was handed every 2.5s, so
// text arrived in 400-900 character blocks, each cut mid-word, and the page
// grew 200px at a time (recorded 2026-10-12). The server now flushes every
// half second and the reader asks every second; what arrives is a target,
// and this decides how much of it is on screen.
//
// - The pace is a reader's, with a catch-up: the backlog is shown over about
//   a second and a half, so a burst never lands at once and a slow stretch
//   never stalls the text that has already arrived. A backlog too big to type
//   (a reload half-way through) is shown at once, all but its tail.
// - Counting is in visible characters: a tag costs nothing and is never cut,
//   an entity is one character, and every prefix is closed so it renders.
// - The text is split into top-level blocks, each its own element keyed by
//   position. A block that is complete never changes again, so React leaves
//   its DOM alone and nothing already shown re-renders; only the block being
//   typed does.
//
// Pure, so the pace and the cuts are tested without a browser.

/** Characters a second when there is no backlog to speak of: a calm typing pace. */
export const BASE_CPS = 60;
/** The backlog is shown over about this long, so text keeps pace with the writer. */
export const CATCH_UP_S = 1.2;
/** A little faster than the text arrives, so the backlog drains instead of building. */
const AHEAD = 1.15;
/** Past this many characters behind, the rest is shown at once but for the tail. */
export const MAX_BACKLOG = 1_400;
/** The tail still typed out after a snap. */
const SNAP_TAIL = 400;

/**
 * How many visible characters to show after `dtMs`, given `shown` and the
 * `available` text. Never past what has arrived, never backwards, never
 * stalled while there is text to show.
 *
 * `arrivalCps`: how fast text has been arriving lately (the reader keeps a
 * moving average). The writer is several times faster than anyone reads -
 * about 250 characters a second on 2026-10-12 - so the text is typed at its
 * pace, a little ahead, and the backlog term catches up after a burst.
 */
export function nextShown(shown: number, available: number, dtMs: number, arrivalCps = 0): number {
  if (available <= shown) return Math.min(shown, available);
  const backlog = available - shown;
  if (backlog > MAX_BACKLOG) return available - SNAP_TAIL;
  const cps = Math.max(BASE_CPS, arrivalCps * AHEAD, backlog / CATCH_UP_S);
  const step = Math.max(1, (cps * Math.max(0, dtMs)) / 1000);
  return Math.min(available, shown + step);
}

/** One piece of the html: a tag, an entity, or a run of text. */
const PIECE = /<[^>]*>|&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});|[^<&]+|&/g;
const TAG = /^<(\/?)([a-zA-Z][\w-]*)/;
const VOID = new Set(["br", "hr", "img", "wbr"]);

function tagOf(piece: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  const m = piece.match(TAG);
  if (!m) return null;
  const name = m[2].toLowerCase();
  return { name, closing: m[1] === "/", selfClosing: VOID.has(name) || piece.endsWith("/>") };
}

/** Visible characters in `html`: text and entities, not tags. */
export function visibleLength(html: string): number {
  let n = 0;
  for (const m of html.matchAll(PIECE)) {
    const piece = m[0];
    if (piece[0] === "<") continue;
    n += piece[0] === "&" ? 1 : piece.length;
  }
  return n;
}

/**
 * The first `count` visible characters of `html`, with every tag it opened
 * closed again. A tag is never cut; an entity counts as one character.
 * Expects the reader's own html (rebuilt from an allowlist, every tag closed).
 */
export function revealPrefix(html: string, count: number): string {
  let left = Math.floor(count);
  let out = "";
  const open: string[] = [];
  for (const m of html.matchAll(PIECE)) {
    const piece = m[0];
    if (piece[0] === "<") {
      const tag = tagOf(piece);
      if (!tag) continue;
      // Once the count is spent, no new element is started: an empty
      // paragraph would be a blank line ahead of the text.
      if (left <= 0 && !tag.closing) break;
      out += piece;
      if (tag.closing) {
        const at = open.lastIndexOf(tag.name);
        if (at !== -1) open.splice(at, 1);
      } else if (!tag.selfClosing) open.push(tag.name);
      continue;
    }
    if (left <= 0) break;
    if (piece[0] === "&") {
      out += piece;
      left -= 1;
      continue;
    }
    out += piece.slice(0, left);
    left -= Math.min(left, piece.length);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/**
 * The top-level elements of `html`, in order. Text outside any element is a
 * block of its own. Expects balanced html (what `revealPrefix` and the
 * reader's allowlist produce).
 */
export function splitBlocks(html: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let current = "";
  for (const m of html.matchAll(PIECE)) {
    const piece = m[0];
    const tag = piece[0] === "<" ? tagOf(piece) : null;
    if (piece[0] === "<" && !tag) continue;
    if (depth === 0 && !tag && !piece.trim()) continue;
    current += piece;
    if (tag && !tag.selfClosing) depth += tag.closing ? -1 : 1;
    if (depth < 0) depth = 0;
    if (depth === 0) {
      blocks.push(current);
      current = "";
    }
  }
  if (current.trim()) blocks.push(current);
  return blocks;
}

const CLOSING_TAIL = /(?:<\/[a-zA-Z][\w-]*>)+$/;

/** The block with a caret at the end of its text, inside whatever it left open. */
export function withCaret(block: string, caret = '<span class="stream-caret" aria-hidden="true"></span>'): string {
  const tail = block.match(CLOSING_TAIL)?.[0] ?? "";
  return block.slice(0, block.length - tail.length) + caret + tail;
}
