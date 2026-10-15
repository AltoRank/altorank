import { describe, expect, it } from "vitest";
import { BASE_CPS, MAX_BACKLOG, nextShown, revealPrefix, splitBlocks, visibleLength, withCaret } from "../stream-reveal";

// The gate's reader, revealing the first article as it arrives: the pace,
// and the cuts. Pure; the component only feeds it frames.

const ARTICLE =
  "<p>Intro with <a href=\"https://ok.example\" rel=\"nofollow noopener noreferrer\">a link</a> &amp; more.</p>" +
  "<h2>Key takeaways</h2><ul><li>One</li><li>Two</li></ul>" +
  "<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table><p>End.</p>";

/** Frames of `dtMs` until `shown` reaches `available`, or `cap` frames. */
function framesToCatchUp(shown: number, available: number, dtMs: number, arrivalCps = 0, cap = 10_000): number {
  let n = 0;
  while (shown < available && n < cap) {
    const next = nextShown(shown, available, dtMs, arrivalCps);
    expect(next).toBeGreaterThan(shown);
    shown = next;
    n++;
  }
  return n;
}

describe("the pace", () => {
  it("never goes past what has arrived, and never backwards", () => {
    expect(nextShown(100, 100, 50)).toBe(100);
    expect(nextShown(120, 100, 50)).toBe(100);
    expect(nextShown(0, 3, 1_000)).toBe(3);
  });

  it("types a small backlog at a calm pace rather than dropping it at once", () => {
    // 20 characters arrive: a reader's pace, not one frame.
    const first = nextShown(0, 20, 16);
    expect(first).toBeLessThan(20);
    expect(first).toBeGreaterThanOrEqual((BASE_CPS * 16) / 1000);
  });

  it("keeps pace with the writer: a second's text is typed in about a second, not dropped in one frame", () => {
    // The writer streamed about 250 characters a second (2026-10-12).
    const atPace = framesToCatchUp(0, 250, 16, 250);
    expect(atPace * 16).toBeLessThan(1_100);
    expect(atPace * 16).toBeGreaterThan(500);
    // Before the pace is known, the backlog alone drains it within three seconds.
    expect(framesToCatchUp(0, 250, 16) * 16).toBeLessThan(3_000);
  });

  it("never stalls while there is text to show", () => {
    let shown = 0;
    for (let i = 0; i < 400; i++) shown = nextShown(shown, 1_000, 16);
    expect(shown).toBe(1_000);
  });

  it("shows a backlog too big to type at once, all but its tail", () => {
    const next = nextShown(0, 9_000, 16);
    expect(next).toBeGreaterThan(9_000 - MAX_BACKLOG);
    expect(next).toBeLessThan(9_000);
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
