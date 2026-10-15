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
// - The pace is a reader's, not the writer's. The writer streams about 250
//   characters a second (2026-10-12), five times faster than anyone reads,
//   and a page typing at that speed read as a firehose and then a wall (UX
//   audit 2026-10-12, #10). So while the body is being written the text is
//   typed at a steady reading pace, a little quicker when a backlog has
//   built up, never faster than a quick reader. Once the body is saved the
//   rest is typed faster, finishing within about FINISH_S, still a character
//   at a time. The speed changes gently (ACCEL), so there is never a burst.
// - A reload half-way through starts with what was already there shown, all
//   but its tail (`startAt`): that is the first frame, not a jump mid-read.
// - Counting is in visible characters: a tag costs nothing and is never cut,
//   an entity is one character, and every prefix is closed so it renders.
// - The text is split into top-level blocks, each its own element keyed by
//   position. A block that is complete never changes again, so React leaves
//   its DOM alone and nothing already shown re-renders; only the block being
//   typed does.
//
// Pure, so the pace and the cuts are tested without a browser.

/** Characters a second with no backlog: about 330 words a minute, a steady reader. */
export const READ_CPS = 30;
/** The most while the body is still being written: a quick reader, never a skim. */
export const WRITING_MAX_CPS = 48;
/** How fast the backlog is worked off while writing: a 25-second view of it. */
const WRITING_CATCH_UP_S = 25;
/** Once the body is saved, what is left is typed within about this long. */
export const FINISH_S = 15;
/** The most the speed changes in a second, either way: no lurch, no burst. */
export const ACCEL = 160;
/** On the first frame, more than this already arrived is shown at once, but for the tail. */
export const MAX_BACKLOG = 1_400;
/** The tail still typed out after that first frame. */
const SNAP_TAIL = 400;

/** The reveal between frames: how much is shown, and how fast it is moving. */
export interface RevealState {
  shown: number;
  cps: number;
}

/**
 * Where a reveal starts: everything when the body was already written when
 * the page opened (there is nothing to watch), all but a typed tail when a
 * reload lands half-way through, and nothing otherwise.
 */
export function startAt(available: number, done: boolean): RevealState {
  if (done) return { shown: available, cps: 0 };
  return { shown: available > MAX_BACKLOG ? available - SNAP_TAIL : 0, cps: READ_CPS };
}

/**
 * The speed the reveal is heading for, given what is waiting and how fast it
 * is going. While the body is written: a reading pace, nudged up by the
 * backlog, capped at a quick reader. Once it is saved: fast enough to finish
 * in about FINISH_S, holding that speed rather than easing off as the
 * backlog shrinks (an easing finish never finishes), then slowing into the
 * last half-second of text.
 */
export function targetCps(backlog: number, done: boolean, cps = READ_CPS): number {
  if (backlog <= 0) return 0;
  if (!done) return Math.min(WRITING_MAX_CPS, READ_CPS + backlog / WRITING_CATCH_UP_S);
  if (backlog <= cps * 0.4) return Math.max(READ_CPS, backlog * 2);
  return Math.max(cps, READ_CPS, backlog / (FINISH_S * 0.8));
}

/**
 * The next frame: `dtMs` later, with `available` characters arrived and the
 * body `done` or not. Never past what has arrived, never backwards, never
 * stalled while there is text to show, and the speed moves by at most ACCEL
 * a second. `shown` is fractional; the cut rounds it down.
 */
export function revealStep(state: RevealState, available: number, dtMs: number, done: boolean): RevealState {
  if (available <= state.shown) return { shown: Math.min(state.shown, available), cps: Math.min(state.cps, READ_CPS) };
  const dt = Math.max(0, dtMs) / 1000;
  const target = targetCps(available - state.shown, done, state.cps);
  const delta = Math.max(-ACCEL * dt, Math.min(ACCEL * dt, target - state.cps));
  const cps = Math.max(READ_CPS, state.cps + delta);
  return { shown: Math.min(available, state.shown + cps * dt), cps };
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
