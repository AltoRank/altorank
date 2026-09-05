import { describe, it, expect } from "vitest";
import { validateRewrite } from "../validate";

const before =
  '<h1>T</h1><p>Intro</p><h2>A</h2><p>See <a href="/blog/other">other</a>.</p><img src="/a.png" alt="a"><h2>B</h2><p>Long enough text here for a count.</p>';

describe("validateRewrite", () => {
  it("passes a faithful rewrite", () => {
    const after = before.replace("<p>Intro</p>", "<p>A sharper intro.</p>");
    expect(validateRewrite(before, after, { siteDomain: "example.com" })).toEqual([]);
  });

  it("flags lost headings, images and internal links", () => {
    const after = "<h1>T</h1><p>Intro</p><p>No links or images or sections.</p>";
    const codes = validateRewrite(before, after, { siteDomain: "example.com" }).map((i) => i.code);
    expect(codes).toContain("no_headings");
    expect(codes).toContain("images_dropped");
    expect(codes).toContain("links_dropped");
  });

  it("flags a new internal link the site is not known to have", () => {
    const after = before + '<p><a href="/blog/invented">new</a></p>';
    const issues = validateRewrite(before, after, {
      siteDomain: "example.com",
      knownPaths: new Set(["/blog/other"]),
    });
    expect(issues.map((i) => i.code)).toContain("unknown_internal_link");
    // ...and not when the page exists.
    const ok = validateRewrite(before, after, {
      siteDomain: "example.com",
      knownPaths: new Set(["/blog/other", "/blog/invented"]),
    });
    expect(ok.map((i) => i.code)).not.toContain("unknown_internal_link");
  });

  it("flags dead links, big cuts and banned phrases", () => {
    const after =
      '<h1>T</h1><h2>A</h2><p>Let\'s dive in. See <a href="/blog/other">other</a>.</p><img src="/a.png" alt="a"><a href="#">x</a>';
    const codes = validateRewrite(before, after, { siteDomain: "example.com" }).map((i) => i.code);
    expect(codes).toContain("dead_links");
    expect(codes).toContain("shorter");
    expect(codes).toContain("ai_fluff");
  });
});
