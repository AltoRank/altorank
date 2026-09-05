import { describe, it, expect } from "vitest";
import { splitBlocks, diffBlocks, applyDecisions, summarizeDecisions, readDecisions } from "../hunks";

describe("splitBlocks", () => {
  it("splits top-level blocks and keeps nested lists whole", () => {
    const html = `<h1>T</h1>\n<p>One <a href="/x">link</a>.</p><ul><li>a<ul><li>b</li></ul></li></ul><img src="a.png" alt="">`;
    expect(splitBlocks(html)).toEqual([
      "<h1>T</h1>",
      '<p>One <a href="/x">link</a>.</p>',
      "<ul><li>a<ul><li>b</li></ul></li></ul>",
      '<img src="a.png" alt="">',
    ]);
  });

  it("wraps stray text in a paragraph so nothing is lost", () => {
    expect(splitBlocks("hello <strong>there</strong><p>x</p>")).toEqual(["<p>hello <strong>there</strong></p>", "<p>x</p>"]);
  });
});

describe("diffBlocks", () => {
  const before = "<h1>Title</h1><p>Intro.</p><h2>A</h2><p>Old A.</p><h2>B</h2><p>B text.</p>";

  it("marks identical blocks unchanged, ignoring whitespace", () => {
    const hunks = diffBlocks(before, before.replace("<p>Intro.</p>", "<p>\n  Intro.\n</p>"));
    expect(hunks.every((h) => h.kind === "unchanged")).toBe(true);
    expect(hunks).toHaveLength(6);
  });

  it("pairs a rewritten paragraph as changed and a new block as added", () => {
    const after = "<h1>Title</h1><p>Intro.</p><h2>A</h2><p>New A.</p><h2>B</h2><p>B text.</p><h2>FAQ</h2>";
    const hunks = diffBlocks(before, after);
    const kinds = hunks.map((h) => h.kind);
    expect(kinds).toEqual(["unchanged", "unchanged", "unchanged", "changed", "unchanged", "unchanged", "added"]);
    const changed = hunks[3];
    expect(changed.before).toBe("<p>Old A.</p>");
    expect(changed.after).toBe("<p>New A.</p>");
    expect(hunks[6].after).toBe("<h2>FAQ</h2>");
    expect(hunks[6].before).toBeNull();
  });

  it("marks a dropped block removed", () => {
    const after = "<h1>Title</h1><p>Intro.</p><h2>A</h2><p>Old A.</p>";
    const hunks = diffBlocks(before, after);
    expect(hunks.filter((h) => h.kind === "removed").map((h) => h.before)).toEqual(["<h2>B</h2>", "<p>B text.</p>"]);
  });

  it("gives every hunk a unique id", () => {
    const ids = diffBlocks(before, before + "<p>z</p>").map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("applyDecisions", () => {
  const before = "<h1>T</h1><p>keep</p><p>old</p><p>gone</p>";
  const after = "<h1>T</h1><p>keep</p><p>new</p><p>extra</p>";
  const hunks = diffBlocks(before, after);
  // unchanged, unchanged, changed(old->new), changed(gone->extra)
  const changed = hunks.filter((h) => h.kind === "changed");

  it("with no decisions returns the original", () => {
    expect(applyDecisions(hunks)).toBe("<h1>T</h1>\n<p>keep</p>\n<p>old</p>\n<p>gone</p>");
  });

  it("applies accepted changes and keeps rejected ones as they were", () => {
    const out = applyDecisions(hunks, { [changed[0].id]: "accepted", [changed[1].id]: "rejected" });
    expect(out).toBe("<h1>T</h1>\n<p>keep</p>\n<p>new</p>\n<p>gone</p>");
  });

  it("an edited hunk wins over both sides", () => {
    const out = applyDecisions(hunks, { [changed[0].id]: "accepted" }, { [changed[0].id]: "<p>mine</p>" });
    expect(out).toContain("<p>mine</p>");
    expect(out).not.toContain("<p>new</p>");
  });

  it("added blocks appear only when accepted; removed blocks vanish only when accepted", () => {
    const h = diffBlocks("<p>a</p><p>b</p>", "<p>a</p><p>c</p><p>d</p>");
    // changed(b->c), added(d)
    const added = h.find((x) => x.kind === "added")!;
    expect(applyDecisions(h, { [added.id]: "accepted" })).toBe("<p>a</p>\n<p>b</p>\n<p>d</p>");
    const h2 = diffBlocks("<p>a</p><p>b</p>", "<p>a</p>");
    const removed = h2.find((x) => x.kind === "removed")!;
    expect(applyDecisions(h2)).toBe("<p>a</p>\n<p>b</p>");
    expect(applyDecisions(h2, { [removed.id]: "accepted" })).toBe("<p>a</p>");
  });
});

describe("summarizeDecisions", () => {
  it("counts kept out of reviewable, and what is still undecided", () => {
    const hunks = diffBlocks("<p>a</p><p>b</p><p>c</p>", "<p>a</p><p>B</p><p>C</p><p>d</p>");
    const changed = hunks.filter((h) => h.kind !== "unchanged");
    expect(changed).toHaveLength(3);
    expect(summarizeDecisions(hunks)).toEqual({ kept: 0, total: 3, undecided: 3 });
    expect(summarizeDecisions(hunks, { [changed[0].id]: "accepted", [changed[1].id]: "rejected" })).toEqual({
      kept: 1,
      total: 3,
      undecided: 1,
    });
    expect(summarizeDecisions(hunks, {}, { [changed[2].id]: "<p>x</p>" }).kept).toBe(1);
  });
});

describe("readDecisions", () => {
  it("tolerates an empty or malformed column", () => {
    expect(readDecisions(null)).toEqual({ decisions: {}, edited: {}, fields: {} });
    expect(readDecisions({ decisions: "nope" })).toEqual({ decisions: {}, edited: {}, fields: {} });
    expect(readDecisions({ decisions: { h1: "accepted" }, fields: { title: "accepted" } })).toEqual({
      decisions: { h1: "accepted" },
      edited: {},
      fields: { title: "accepted" },
    });
  });
});
