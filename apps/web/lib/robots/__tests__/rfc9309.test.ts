import { describe, it, expect } from "vitest";
import { decidingRule, evaluateRobots, parseRobotsTxt, productToken, selectGroups } from "../rfc9309";

// Carried over from the public tools' tester (PR #243) when the matcher moved
// here, plus the regressions that motivated the move.

const v = (file: string, token: string, path: string) => evaluateRobots(parseRobotsTxt(file), token, path);

describe("RFC 9309 matching", () => {
  it("longest match wins, whatever the order", () => {
    const f = "User-agent: *\nAllow: /p\nDisallow: /\n";
    expect(v(f, "x", "/page").allowed).toBe(true);
    expect(v(f, "x", "/other").allowed).toBe(false);
    expect(v("User-agent: *\nDisallow: /folder/page\nAllow: /folder\n", "x", "/folder/page").allowed).toBe(false);
  });

  it("Allow wins an exact tie", () => {
    const r = v("User-agent: *\nDisallow: /page\nAllow: /page\n", "x", "/page");
    expect(r.allowed).toBe(true);
    expect(r.rule?.line).toBe(3);
  });

  it("supports * and the $ anchor", () => {
    const f = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/secret\n";
    expect(v(f, "x", "/a/b.pdf").allowed).toBe(false);
    expect(v(f, "x", "/a/b.pdf?x=1").allowed).toBe(true);
    expect(v(f, "x", "/private-area/secret").allowed).toBe(false);
  });

  it("matches the query string too", () => {
    expect(v("User-agent: *\nDisallow: /*?sort=\n", "x", "/list?sort=asc").allowed).toBe(false);
  });

  it("an empty Disallow allows everything", () => {
    expect(v("User-agent: *\nDisallow:\n", "x", "/anything").allowed).toBe(true);
  });

  it("a named group replaces * entirely", () => {
    const f = "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n";
    expect(v(f, "GPTBot", "/x")).toMatchObject({ allowed: true, group: "GPTBot" });
    expect(v(f, "ClaudeBot", "/x")).toMatchObject({ allowed: false, group: "*" });
  });

  it("matches the agent case-insensitively and exactly, not by substring", () => {
    const f = "User-agent: googlebot-image\nDisallow: /\n";
    expect(v(f, "Googlebot", "/").allowed).toBe(true);
    expect(v("User-agent: GOOGLEBOT\nDisallow: /\n", "Googlebot", "/").allowed).toBe(false);
  });

  it("groups consecutive user-agent lines, and merges repeated groups", () => {
    const f = "User-agent: a\nUser-agent: b\nDisallow: /x\n\nUser-agent: b\nDisallow: /y\n";
    expect(v(f, "a", "/x").allowed).toBe(false);
    expect(v(f, "b", "/x").allowed).toBe(false);
    expect(v(f, "b", "/y").allowed).toBe(false);
    expect(v(f, "a", "/y").allowed).toBe(true);
  });

  it("strips versions from agent names", () => {
    expect(v("User-agent: GPTBot/1.0\nDisallow: /\n", "GPTBot", "/").allowed).toBe(false);
  });

  it("always allows /robots.txt", () => {
    expect(v("User-agent: *\nDisallow: /\n", "x", "/robots.txt").allowed).toBe(true);
  });

  it("no group and no * group allows everything", () => {
    expect(v("User-agent: other\nDisallow: /\n", "x", "/")).toMatchObject({ allowed: true, group: null });
  });

  it("normalises percent-encoding case and non-ASCII paths", () => {
    expect(v("User-agent: *\nDisallow: /caf%c3%a9\n", "x", "/caf%C3%A9").allowed).toBe(false);
    expect(v("User-agent: *\nDisallow: /café\n", "x", "/caf%C3%A9").allowed).toBe(false);
  });

  it("collects sitemaps, ignores comments and CRLF, and lists junk lines", () => {
    const p = parseRobotsTxt("﻿User-agent: * # all\r\nDisallow: /a\r\nSitemap: https://x.com/s.xml\r\nthis is junk\r\nCrawl-delay: 5\r\n");
    expect(p.sitemaps).toEqual(["https://x.com/s.xml"]);
    expect(p.groups[0].rules).toHaveLength(1);
    expect(p.unknownLines).toEqual([{ line: 4, text: "this is junk" }]);
  });
});

describe("group selection: exact product token, never substring", () => {
  it("does not apply a Googlebot-Image group to Googlebot, or the reverse", () => {
    const f = "User-agent: *\nAllow: /\n\nUser-agent: Googlebot-Image\nDisallow: /\n";
    expect(v(f, "Googlebot", "/")).toMatchObject({ allowed: true, group: "*" });
    expect(v(f, "Googlebot-Image", "/")).toMatchObject({ allowed: false, group: "Googlebot-Image" });
    const g = "User-agent: Googlebot\nDisallow: /\n";
    expect(v(g, "Googlebot-Image", "/")).toMatchObject({ allowed: true, group: null });
  });

  it("keeps AI crawlers apart from the search crawlers whose names they extend", () => {
    const f = "User-agent: Applebot\nUser-agent: Google\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(v(f, "Applebot-Extended", "/").allowed).toBe(true);
    expect(v(f, "Google-Extended", "/").allowed).toBe(true);
    expect(v(f, "Applebot", "/").allowed).toBe(false);
  });

  it("does not let a short token catch every crawler containing it", () => {
    const f = "User-agent: bot\nDisallow: /\n";
    for (const token of ["GPTBot", "ClaudeBot", "PerplexityBot", "CCBot"]) {
      expect(v(f, token, "/")).toMatchObject({ allowed: true, group: null });
    }
  });

  it("returns every group naming the token, in file order", () => {
    const p = parseRobotsTxt("User-agent: GPTBot\nDisallow: /a\n\nUser-agent: *\nDisallow: /\n\nUser-agent: gptbot\nDisallow: /b\n");
    const { groups, name } = selectGroups(p, "GPTBot");
    expect(name).toBe("GPTBot");
    expect(groups.map((g) => g.line)).toEqual([1, 7]);
  });

  it("keeps Crawl-delay on the group that set it", () => {
    const p = parseRobotsTxt("User-agent: a\nCrawl-delay: 5\n\nUser-agent: b\nDisallow: /\n");
    expect(p.groups.map((g) => g.crawlDelay)).toEqual([5, null]);
    expect(p.unknownLines).toEqual([]);
  });
});

describe("decidingRule", () => {
  it("returns null when nothing matches", () => {
    expect(decidingRule([{ allow: false, pattern: "/x", line: 1 }], "/y")).toBeNull();
  });

  it("uses pattern length, not file order, and Allow on a tie", () => {
    const rules = [
      { allow: false, pattern: "/", line: 1 },
      { allow: true, pattern: "/$", line: 2 },
      { allow: false, pattern: "/$", line: 3 },
    ];
    expect(decidingRule(rules, "/")).toEqual(rules[1]);
    expect(decidingRule(rules, "/about")).toEqual(rules[0]);
  });
});

describe("productToken", () => {
  it("reads a token from a full user-agent string", () => {
    expect(productToken("GPTBot")).toBe("GPTBot");
    expect(productToken("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)", ["GPTBot", "Googlebot"])).toBe("GPTBot");
    expect(productToken("MyCrawler/2.0 (+https://x)")).toBe("MyCrawler");
  });

  it("prefers the longest known token, so Googlebot-Image is not read as Googlebot", () => {
    expect(productToken("Googlebot-Image/1.0", ["Googlebot", "Googlebot-Image"])).toBe("Googlebot-Image");
  });
});
