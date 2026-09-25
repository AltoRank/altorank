import { describe, it, expect } from "vitest";
import { evaluateRobots, loadRobotsTxt, parseRobotsTxt, productToken, robotsVerdictFor } from "../robots";
import { fakeFetch } from "./fake-fetch";
import { FetchFailedError } from "../safe-fetch";

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

describe("productToken", () => {
  it("reads a token from a full user-agent string", () => {
    expect(productToken("GPTBot")).toBe("GPTBot");
    expect(productToken("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)", ["GPTBot", "Googlebot"])).toBe("GPTBot");
    expect(productToken("MyCrawler/2.0 (+https://x)")).toBe("MyCrawler");
  });
});

describe("loadRobotsTxt: availability per RFC 9309 §2.3.1", () => {
  const page = "https://x.com/some/page";
  it("404 means no file: everything allowed", async () => {
    const load = await loadRobotsTxt(page, fakeFetch({ "https://x.com/robots.txt": { status: 404 } }));
    expect(load.state).toBe("missing");
    expect(robotsVerdictFor(load, "GPTBot", page).allowed).toBe(true);
  });

  it("5xx and 429 mean unreachable: nothing allowed", async () => {
    for (const status of [503, 429]) {
      const load = await loadRobotsTxt(page, fakeFetch({ "https://x.com/robots.txt": { status } }));
      expect(load.state).toBe("unreachable");
      expect(robotsVerdictFor(load, "GPTBot", page).allowed).toBe(false);
    }
  });

  it("a network failure is unreachable", async () => {
    const load = await loadRobotsTxt(page, fakeFetch({ "https://x.com/robots.txt": new FetchFailedError("timed out", "u") }));
    expect(load.state).toBe("unreachable");
  });

  it("too many redirects is unavailable, not unreachable", async () => {
    const load = await loadRobotsTxt(page, fakeFetch({ "https://x.com/robots.txt": new FetchFailedError("it redirected more than 5 times", "u") }));
    expect(load.state).toBe("missing");
  });

  it("an HTML 200 is a soft 404", async () => {
    const load = await loadRobotsTxt(page, fakeFetch({ "https://x.com/robots.txt": { body: "<!doctype html><p>Not found</p>" } }));
    expect(load.state).toBe("missing");
  });

  it("a real file is parsed and applied to the page path", async () => {
    const load = await loadRobotsTxt(page, fakeFetch({ "https://x.com/robots.txt": { body: "User-agent: GPTBot\nDisallow: /some/\n" } }));
    const verdict = robotsVerdictFor(load, "GPTBot", page);
    expect(verdict.allowed).toBe(false);
    expect(verdict.summary).toMatch(/Disallow: \/some\/ \(line 2\), group GPTBot/);
  });
});
