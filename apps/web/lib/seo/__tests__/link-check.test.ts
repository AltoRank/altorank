import { describe, it, expect } from "vitest";
import {
  verifyOutboundLinks,
  isUnsafeHost,
  classifyLinkResponse,
  classifyLinkError,
  botChallengeOf,
  defaultFetcher,
  type LinkFetcher,
} from "../link-check";
import { FetchFailedError, UnsafeUrlError, type SafeFetch, type SafeFetchOptions } from "@/lib/public-tools/safe-fetch";

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

// ---------------------------------------------------------------------------
// What counts as dead. A real signup's draft (2026-09-22, Turkish web/mobile
// agency) lost a valid Google Play source to this checker. Only a definitive
// answer removes a link: 404/410 to a GET, a name that does not exist, a
// refused connection. Bot walls, rate limits, challenges and timeouts keep it.
// ---------------------------------------------------------------------------

const PLAY = "https://play.google.com/store/apps/details?id=com.example.cargo&hl=tr";

describe("classifyLinkResponse", () => {
  it("keeps a Play-style 403 or 429 as unverified", () => {
    for (const status of [403, 429]) {
      expect(classifyLinkResponse(PLAY, { status, method: "GET" })).toEqual({
        verdict: "unverified",
        reason: `HTTP ${status}, could not verify`,
      });
    }
  });

  it("keeps every bot-wall, login-wall and rate-limit status", () => {
    for (const status of [401, 403, 405, 429, 451, 999, 500, 503, 400]) {
      expect(classifyLinkResponse("https://guarded.example/x", { status, method: "GET" }).verdict).toBe("unverified");
    }
  });

  it("removes a 404 or 410 to a GET", () => {
    expect(classifyLinkResponse("https://gone.example/x", { status: 404, method: "GET" })).toEqual({ verdict: "dead", reason: "HTTP 404, page gone" });
    expect(classifyLinkResponse("https://gone.example/x", { status: 410 })).toEqual({ verdict: "dead", reason: "HTTP 410, page gone" });
  });

  it("does not take a 404 to HEAD as final", () => {
    expect(classifyLinkResponse("https://gone.example/x", { status: 404, method: "HEAD" }).verdict).toBe("unverified");
  });

  it("keeps a 404 from a store that hides listings by country", () => {
    const out = classifyLinkResponse(PLAY, { status: 404, method: "GET" });
    expect(out.verdict).toBe("unverified");
    expect(out.reason).toMatch(/countries/);
  });

  it("keeps a Cloudflare or Akamai challenge page whatever its status says", () => {
    const cf = { status: 403, headers: { server: "cloudflare", "cf-mitigated": "challenge" }, body: "", method: "GET" as const };
    expect(classifyLinkResponse("https://guarded.example/x", cf)).toEqual({
      verdict: "unverified",
      reason: "HTTP 403, a Cloudflare challenge page; could not verify",
    });
    // A challenge served with 200 is still not the page.
    const js = { status: 200, body: "<html><head><title>Just a moment...</title></head></html>", method: "GET" as const };
    expect(classifyLinkResponse("https://guarded.example/x", js).verdict).toBe("unverified");
    // And one served with 404 is not the page being gone.
    const akamai = {
      status: 404,
      headers: { server: "AkamaiGHost" },
      body: "<html><head><title>Access Denied</title></head><body>Reference&#32;#18.abc</body></html>",
      method: "GET" as const,
    };
    expect(classifyLinkResponse("https://guarded.example/x", akamai).verdict).toBe("unverified");
  });

  it("recognises no challenge on an ordinary page", () => {
    expect(botChallengeOf({ server: "nginx" }, "<html><head><title>Annual report</title></head></html>")).toBeNull();
  });
});

describe("classifyLinkError", () => {
  const net = (code: string, message = "the request failed") =>
    Object.assign(new FetchFailedError(message, "https://x.example/"), { cause: { code } });

  it("removes a name that does not exist and a refused connection", () => {
    expect(classifyLinkError(net("ENOTFOUND"))).toEqual({ verdict: "dead", reason: "host not found" });
    expect(classifyLinkError(net("ECONNREFUSED"))).toEqual({ verdict: "dead", reason: "connection refused" });
  });

  it("keeps a timeout, a reset and a temporary DNS failure", () => {
    expect(classifyLinkError(new FetchFailedError("timed out", "https://x.example/"))).toEqual({ verdict: "unverified", reason: "timed out" });
    expect(classifyLinkError(net("ECONNRESET")).verdict).toBe("unverified");
    expect(classifyLinkError(net("EAI_AGAIN")).verdict).toBe("unverified");
  });

  it("removes a name that resolves to a private address, and only records a port it will not open", () => {
    expect(classifyLinkError(new UnsafeUrlError("evil.example resolves to a private or local address. Only public websites can be checked."))).toEqual({
      verdict: "dead",
      reason: "not a public host",
    });
    expect(classifyLinkError(new UnsafeUrlError("Port 8000 is not fetched. Public websites answer on 80 or 443.")).verdict).toBe("unverified");
  });
});

describe("defaultFetcher", () => {
  function fake(routes: Record<string, { status: number; headers?: Record<string, string>; body?: string } | Error>) {
    const calls: string[] = [];
    const fn: SafeFetch = async (url: string, opts: SafeFetchOptions = {}) => {
      const method = opts.method ?? "GET";
      calls.push(method);
      const r = routes[method];
      if (r instanceof Error) throw r;
      return {
        requestedUrl: url, url, status: r.status, headers: r.headers ?? {}, body: method === "HEAD" ? "" : r.body ?? "",
        bodyBuffer: Buffer.from(""), bytes: 0, truncated: false, redirects: [], tlsUnverified: false, timeMs: 1,
      };
    };
    return { fn, calls };
  }

  it("stops at a HEAD that answers", async () => {
    const { fn, calls } = fake({ HEAD: { status: 200 }, GET: new Error("should not GET") });
    expect(await defaultFetcher(1000, fn)(PLAY)).toMatchObject({ status: 200, method: "HEAD" });
    expect(calls).toEqual(["HEAD"]);
  });

  it("asks again with GET when HEAD says 404, and believes the GET", async () => {
    const { fn, calls } = fake({ HEAD: { status: 404 }, GET: { status: 200, body: "<html>app</html>" } });
    const res = await defaultFetcher(1000, fn)("https://apps.example/app/1");
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(classifyLinkResponse("https://apps.example/app/1", res).verdict).toBe("live");
  });

  it("hands the GET's headers and body to the classifier, so a challenge is recognised", async () => {
    const { fn } = fake({ HEAD: { status: 405 }, GET: { status: 403, headers: { "cf-mitigated": "challenge" }, body: "" } });
    const res = await defaultFetcher(1000, fn)("https://guarded.example/x");
    expect(classifyLinkResponse("https://guarded.example/x", res).reason).toMatch(/Cloudflare/);
  });

  it("does not ask a name that does not resolve twice", async () => {
    const dns = Object.assign(new FetchFailedError("the domain does not resolve", "https://nowhere.invalid/"), { cause: { code: "ENOTFOUND" } });
    const { fn, calls } = fake({ HEAD: dns, GET: new Error("should not GET") });
    await expect(defaultFetcher(1000, fn)("https://nowhere.invalid/")).rejects.toBe(dns);
    expect(calls).toEqual(["HEAD"]);
  });

  it("keeps a Play source through the whole pipeline when Play rate-limits the check", async () => {
    const { fn } = fake({ HEAD: { status: 429 }, GET: { status: 429 } });
    const html = `<p>The app is <a href="${PLAY.replace("&", "&amp;")}">on Google Play</a>.</p>`;
    const { html: out, checks } = await verifyOutboundLinks(html, "ornek-ajans.example", { fetcher: defaultFetcher(1000, fn) });
    expect(out).toBe(html);
    expect(checks).toEqual([expect.objectContaining({ url: PLAY, status: 429, ok: false, verdict: "unverified", removed: false })]);
  });
});
