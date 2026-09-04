import { describe, it, expect } from "vitest";
import {
  fieldCounter,
  pendingCount,
  pendingLabel,
  NO_CHANGES,
  applyHunks,
  surroundingParagraph,
  outlineOf,
} from "../proposals";

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

describe("applyHunks", () => {
  it("is all-or-nothing until the hunk library lands", () => {
    expect(applyHunks("<p>a</p>", "<p>b</p>")).toBe("<p>b</p>");
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
