import { describe, it, expect } from "vitest";
import {
  fieldCounter,
  pendingCount,
  pendingLabel,
  NO_CHANGES,
  applyHunks,
  decideAll,
  keptSummary,
  proposeHunks,
  reviewableHunks,
  surroundingParagraph,
  outlineOf,
} from "../proposals";
import { splitBlocks } from "@/lib/refresh/hunks";

describe("fieldCounter", () => {
  it("counts a title against 60", () => {
    expect(fieldCounter("Short title", "title")).toEqual({ count: 11, limit: 60, over: false });
  });
  it("flags a meta description past 160, and only past it", () => {
    const exactly = "x".repeat(160);
    expect(fieldCounter(exactly, "meta_description")).toMatchObject({ count: 160, over: false });
    expect(fieldCounter(exactly + "y", "meta_description")).toMatchObject({ count: 161, over: true });
  });
  it("treats null as empty rather than crashing", () => {
    expect(fieldCounter(null, "meta_description")).toEqual({ count: 0, limit: 160, over: false });
  });
});

describe("pending changes", () => {
  it("says No changes yet at zero", () => {
    expect(pendingCount(NO_CHANGES)).toBe(0);
    expect(pendingLabel(NO_CHANGES)).toBe("No changes yet");
  });
  it("counts fields once each and body edits as given, singular at one", () => {
    expect(pendingLabel({ ...NO_CHANGES, title: true })).toBe("1 proposed change");
    expect(pendingLabel({ title: true, meta: true, featuredImage: true, body: 2 })).toBe("5 proposed changes");
  });
});

describe("hunk review", () => {
  const before = "<h2>Intro</h2><p>old one</p><p>same</p><p>old two</p>";
  const after = "<h2>Intro</h2><p>new one</p><p>same</p><p>new two</p><ul><li>extra</li></ul>";
  const hunks = proposeHunks(before, after);
  const open = reviewableHunks(hunks);

  it("diffs with the refresh engine's blocks: two rewritten, one added", () => {
    expect(open.map((h) => h.kind)).toEqual(["changed", "changed", "added"]);
  });

  it("keeps a mix: kept hunks take the rewrite, rejected ones the original", () => {
    const out = applyHunks(hunks, { [open[0].id]: "accepted", [open[1].id]: "rejected", [open[2].id]: "accepted" });
    expect(out).toBe("<h2>Intro</h2>\n<p>new one</p>\n<p>same</p>\n<p>old two</p>\n<ul><li>extra</li></ul>");
  });

  it("rejecting everything returns the original, block for block", () => {
    expect(splitBlocks(applyHunks(hunks, decideAll(hunks, "rejected")))).toEqual(splitBlocks(before));
  });

  it("keeping everything returns the proposal, block for block", () => {
    expect(splitBlocks(applyHunks(hunks, decideAll(hunks, "accepted")))).toEqual(splitBlocks(after));
  });

  it("an undecided hunk keeps the original", () => {
    expect(applyHunks(hunks, {})).toBe(splitBlocks(before).join("\n"));
  });

  it("a no-op rewrite has nothing to review and applies to the same article", () => {
    const same = proposeHunks(before, before.replace("<p>same</p>", "<p>\n  same\n</p>"));
    expect(reviewableHunks(same)).toEqual([]);
    expect(splitBlocks(applyHunks(same, decideAll(same, "accepted")))).toEqual(splitBlocks(before));
  });

  it("counts kept out of reviewable", () => {
    expect(keptSummary(hunks, decideAll(hunks, "accepted"))).toEqual({ kept: 3, total: 3, undecided: 0 });
    expect(keptSummary(hunks, { [open[0].id]: "accepted" })).toEqual({ kept: 1, total: 3, undecided: 2 });
  });
});

describe("surroundingParagraph", () => {
  const html = '<p>Before <strong>it</strong>.</p><img src="/i.webp" alt=""><p>After it.</p>';
  it("prefers the paragraph after the image, as plain text", () => {
    expect(surroundingParagraph(html, "/i.webp")).toBe("After it.");
  });
  it("falls back to the paragraph before", () => {
    expect(surroundingParagraph('<p>Only <em>before</em>.</p><img src="/i.webp">', "/i.webp")).toBe("Only before.");
  });
  it("is empty when the image is not in the document", () => {
    expect(surroundingParagraph(html, "/nope.webp")).toBe("");
  });
});

describe("outlineOf", () => {
  it("lists the H2s as text", () => {
    expect(outlineOf("<h1>T</h1><h2>One <em>a</em></h2><p>x</p><h2>Two</h2><h3>sub</h3>")).toEqual(["One a", "Two"]);
  });
});
