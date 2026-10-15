import { describe, expect, it } from "vitest";
import { ACCEL, FINISH_S, MAX_BACKLOG, READ_CPS, WRITING_MAX_CPS, revealPrefix, revealStep, splitBlocks, startAt, visibleLength, withCaret, type RevealState } from "../stream-reveal";

// The gate's reader, revealing the first article as it arrives: the pace,
// and the cuts. Pure; the component only feeds it frames.

const ARTICLE =
  "<p>Intro with <a href=\"https://ok.example\" rel=\"nofollow noopener noreferrer\">a link</a> &amp; more.</p>" +
  "<h2>Key takeaways</h2><ul><li>One</li><li>Two</li></ul>" +
  "<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table><p>End.</p>";

const FRAME = 16;

/** Runs frames until everything is shown or `cap` frames; returns the frames and the fastest speed. */
function run(start: RevealState, available: (frame: number) => number, done: (frame: number) => boolean, cap = 100_000) {
  let r = start;
  let frames = 0;
  let fastest = 0;
  let biggestStep = 0;
  let biggestChange = 0;
  while (frames < cap) {
    const avail = available(frames);
    if (r.shown >= avail && done(frames)) break;
    const next = revealStep(r, avail, FRAME, done(frames));
    expect(next.shown).toBeGreaterThanOrEqual(Math.min(r.shown, avail));
    expect(next.shown).toBeLessThanOrEqual(avail);
    biggestStep = Math.max(biggestStep, next.shown - r.shown);
    biggestChange = Math.max(biggestChange, Math.abs(next.cps - r.cps));
    fastest = Math.max(fastest, next.cps);
    r = next;
    frames++;
  }
  return { frames, fastest, biggestStep, biggestChange, end: r };
}

describe("the pace", () => {
  it("never goes past what has arrived, and never backwards", () => {
    expect(revealStep({ shown: 100, cps: READ_CPS }, 100, 50, false).shown).toBe(100);
    expect(revealStep({ shown: 120, cps: READ_CPS }, 100, 50, false).shown).toBe(100);
    expect(revealStep({ shown: 0, cps: READ_CPS }, 3, 1_000, false).shown).toBe(3);
  });

  it("types at a reader's pace while the writer races ahead, and never faster than a quick reader", () => {
    // The writer streamed about 250 characters a second for 40 seconds (2026-10-12).
    const writerCps = 250;
    const writingFrames = (40 * 1000) / FRAME;
    const out = run(startAt(0, false), (f) => Math.min(10_000, Math.floor((f * FRAME * writerCps) / 1000)), () => false, writingFrames);
    expect(out.fastest).toBeLessThanOrEqual(WRITING_MAX_CPS);
    // About 40 seconds at 30-48 characters a second: readable, not a wall.
    expect(out.end.shown).toBeGreaterThan(40 * READ_CPS * 0.9);
    expect(out.end.shown).toBeLessThan(40 * WRITING_MAX_CPS);
  });

  it("has no bursts: no frame shows more than a few characters, and the speed changes gently", () => {
    const out = run({ shown: 0, cps: READ_CPS }, () => 9_000, (f) => f > 600);
    // The fastest finish is a few hundred characters a second: under ten a frame.
    expect(out.biggestStep).toBeLessThan(12);
    expect(out.biggestChange).toBeLessThanOrEqual((ACCEL * FRAME) / 1000 + 1e-9);
  });

  it("once the body is saved, finishes what is left in about FINISH_S, typing all the way", () => {
    const out = run({ shown: 2_000, cps: WRITING_MAX_CPS }, () => 10_000, () => true);
    const seconds = (out.frames * FRAME) / 1000;
    expect(out.end.shown).toBe(10_000);
    expect(seconds).toBeLessThan(FINISH_S + 6);
    expect(seconds).toBeGreaterThan(FINISH_S / 2);
  });

  it("never stalls while there is text to show", () => {
    let r: RevealState = { shown: 0, cps: READ_CPS };
    for (let i = 0; i < 4_000; i++) r = revealStep(r, 1_000, FRAME, false);
    expect(r.shown).toBe(1_000);
  });

  it("starts a page opened half-way through where the text is, but for its tail, and a written one whole", () => {
    const mid = startAt(9_000, false);
    expect(mid.shown).toBeGreaterThan(9_000 - MAX_BACKLOG);
    expect(mid.shown).toBeLessThan(9_000);
    expect(startAt(300, false).shown).toBe(0);
    expect(startAt(9_000, true).shown).toBe(9_000);
  });
});

describe("the cuts", () => {
  it("counts text and entities, not tags", () => {
    expect(visibleLength("<p>a&amp;b</p>")).toBe(3);
    expect(visibleLength(ARTICLE)).toBe("Intro with a link & more.".length + "Key takeaways".length + "OneTwo".length + 2 + "End.".length);
  });

  it("never cuts a tag or an entity, and closes what it opened", () => {
    expect(revealPrefix(ARTICLE, 13)).toBe("<p>Intro with <a href=\"https://ok.example\" rel=\"nofollow noopener noreferrer\">a </a></p>");
    expect(revealPrefix("<p>a&amp;b</p>", 2)).toBe("<p>a&amp;</p>");
    for (let n = 0; n <= visibleLength(ARTICLE); n++) {
      const html = revealPrefix(ARTICLE, n);
      expect(visibleLength(html)).toBe(n);
      expect(html).not.toMatch(/<[^>]*$/);
      expect((html.match(/<[a-z]/g) ?? []).length).toBe((html.match(/<\//g) ?? []).length);
    }
  });

  it("starts no empty element once the count is spent", () => {
    const html = revealPrefix(ARTICLE, "Intro with a link & more.".length);
    expect(html).toMatch(/<\/p>$/);
    expect(html).not.toContain("<h2>");
  });

  it("splits into top-level blocks that do not change as more is revealed", () => {
    const full = splitBlocks(ARTICLE);
    expect(full).toHaveLength(5);
    expect(full[1]).toBe("<h2>Key takeaways</h2>");
    // Every block before the one being typed is identical in each prefix:
    // React is handed the same string and leaves its DOM alone.
    for (let n = 1; n <= visibleLength(ARTICLE); n++) {
      const blocks = splitBlocks(revealPrefix(ARTICLE, n));
      blocks.slice(0, -1).forEach((block, i) => expect(block).toBe(full[i]));
    }
  });

  it("puts the caret at the end of the text, inside whatever is open", () => {
    expect(withCaret("<ul><li>One</li><li>Tw</li></ul>", "|")).toBe("<ul><li>One</li><li>Tw|</li></ul>");
    expect(withCaret("plain", "|")).toBe("plain|");
  });
});
