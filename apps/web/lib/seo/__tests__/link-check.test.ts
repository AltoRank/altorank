import { describe, it, expect } from "vitest";
import { verifyOutboundLinks, isUnsafeHost, type LinkFetcher } from "../link-check";

// Nothing in the pipeline had ever opened a URL the model wrote. This module
// does, once. The policy under test: gone is removed, guarded is kept and
// reported, the site's own links are not touched, and nothing is fetched
// from a host a model should not be able to point a server at.

const responses: Record<string, number | Error> = {
  "https://good.example/report": 200,
  "https://moved.example/old": 301,
  "https://gone.example/404": 404,
  "https://gone.example/410": 410,
  "https://guarded.example/waf": 403,
  "https://down.example/": 503,
  "https://slow.example/": Object.assign(new Error("aborted"), { name: "AbortError" }),
  "https://nowhere.invalid/": Object.assign(new Error("getaddrinfo"), { cause: { code: "ENOTFOUND" } }),
};

const fetcher: LinkFetcher = async (url) => {
  const r = responses[url];
  if (r instanceof Error) throw r;
  if (r === undefined) throw new Error(`unexpected fetch ${url}`);
  return { status: r };
};

const opts = { fetcher, now: () => new Date("2026-09-03T12:00:00Z") };

describe("verifyOutboundLinks", () => {
  it("unwraps a 404 or 410 and a host that does not resolve, keeping the words", async () => {
    const html =
      '<p>See <a href="https://gone.example/404">the old report</a>, ' +
      '<a href="https://gone.example/410">the retired page</a> and ' +
      '<a href="https://nowhere.invalid/">a made-up source</a>.</p>';
    const { html: out, checks } = await verifyOutboundLinks(html, "example.com", opts);
    expect(out).toBe("<p>See the old report, the retired page and a made-up source.</p>");
    expect(checks.every((c) => c.removed && !c.ok)).toBe(true);
    expect(checks.find((c) => c.url.endsWith("/404"))?.reason).toBe("HTTP 404, page gone");
    expect(checks.find((c) => c.url.startsWith("https://nowhere"))?.reason).toBe("host not found");
  });

  it("keeps a guarded, erroring or slow source and says it could not verify", async () => {
    // A real source behind a WAF answers 403 to a bot. Removing it would strip
    // exactly the authoritative citations most likely to be behind one.
    const html =
      '<p><a href="https://guarded.example/waf">Gartner</a> ' +
      '<a href="https://down.example/">Litmus</a> ' +
      '<a href="https://slow.example/">HubSpot</a></p>';
    const { html: out, checks } = await verifyOutboundLinks(html, "example.com", opts);
    expect(out).toBe(html);
    expect(checks.map((c) => [c.ok, c.removed, c.reason])).toEqual([
      [false, false, "HTTP 403, could not verify"],
      [false, false, "HTTP 503, could not verify"],
      [false, false, "timed out"],
    ]);
  });

  it("records 2xx and 3xx as answered", async () => {
    const html = '<p><a href="https://good.example/report">a</a> <a href="https://moved.example/old">b</a></p>';
    const { checks } = await verifyOutboundLinks(html, "example.com", opts);
    expect(checks.map((c) => c.ok)).toEqual([true, true]);
    expect(checks[0].checkedAt).toBe("2026-09-03T12:00:00.000Z");
  });

  it("does not fetch the site's own links, relative links or anchors", async () => {
    const html =
      '<p><a href="https://www.example.com/blog/x">ours</a> <a href="/pricing">pricing</a> ' +
      '<a href="#faq">faq</a> <a href="mailto:a@b.c">mail</a></p>';
    const strict: LinkFetcher = async (url) => {
      throw new Error(`should not fetch ${url}`);
    };
    const { html: out, checks } = await verifyOutboundLinks(html, "example.com", { fetcher: strict });
    expect(out).toBe(html);
    expect(checks).toEqual([]);
  });

  it("fetches each distinct URL once and unwraps every anchor to it", async () => {
    let calls = 0;
    const counting: LinkFetcher = async () => {
      calls++;
      return { status: 404 };
    };
    const html = '<p><a href="https://x.example/a">one</a> and <a href="https://x.example/a">two</a></p>';
    const { html: out, checks } = await verifyOutboundLinks(html, null, { fetcher: counting });
    expect(calls).toBe(1);
    expect(checks).toHaveLength(1);
    expect(out).toBe("<p>one and two</p>");
  });

  it("never fetches a private or literal-IP host, and removes the link", async () => {
    const strict: LinkFetcher = async (url) => {
      throw new Error(`should not fetch ${url}`);
    };
    const html =
      '<p><a href="http://localhost:3000/x">a</a> <a href="http://10.0.0.5/">b</a> ' +
      '<a href="http://169.254.169.254/latest/">c</a> <a href="https://intranet.corp/">d</a></p>';
    const { html: out, checks } = await verifyOutboundLinks(html, null, { fetcher: strict });
    expect(out).toBe("<p>a b c d</p>");
    expect(checks.every((c) => c.removed && c.reason === "not a public host")).toBe(true);
  });

  it("decodes an escaped href before fetching and matches it when unwrapping", async () => {
    const seen: string[] = [];
    const f: LinkFetcher = async (url) => {
      seen.push(url);
      return { status: 404 };
    };
    const html = '<p><a href="https://x.example/?a=1&amp;b=2">q</a></p>';
    const { html: out } = await verifyOutboundLinks(html, null, { fetcher: f });
    expect(seen).toEqual(["https://x.example/?a=1&b=2"]);
    expect(out).toBe("<p>q</p>");
  });

  it("returns the HTML untouched when there is nothing outbound", async () => {
    const { html, checks } = await verifyOutboundLinks("<p>no links</p>", "example.com", opts);
    expect(html).toBe("<p>no links</p>");
    expect(checks).toEqual([]);
  });
});

describe("isUnsafeHost", () => {
  it("names the hosts a server must not be pointed at", () => {
    for (const u of [
      "http://localhost/", "http://127.0.0.1/", "http://192.168.1.1/", "http://172.20.0.1/",
      "http://[::1]/", "http://8.8.8.8/", "http://files.internal/", "not a url",
    ]) expect(isUnsafeHost(u)).toBe(true);
    for (const u of ["https://www.gartner.com/x", "https://example.org"]) expect(isUnsafeHost(u)).toBe(false);
  });
});
