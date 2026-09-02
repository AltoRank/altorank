import { describe, it, expect, vi, afterEach } from "vitest";
import { deriveBlogBaseUrl, urlIsLive } from "../blog-url";

// Fixtures are the shapes these sites actually returned on 2026-09-02, checked
// by running the derivation against them live before pinning anything here.
// Same order as detect.test.ts, and for the same reason: a resolver tested only
// against its author's own fixtures proves the author was consistent.

/** Routes by URL so robots.txt, the sitemap and a page can differ. */
function serve(routes: Record<string, string>, missing: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (missing.some((m) => u.includes(m))) return new Response("", { status: 404 });
      for (const [fragment, body] of Object.entries(routes)) {
        if (u.includes(fragment)) return new Response(body, { status: 200 });
      }
      return new Response("", { status: 404 });
    }),
  );
}

const sitemap = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls
    .map((u) => `<loc>${u}</loc>`)
    .join("")}</urlset>`;

afterEach(() => vi.unstubAllGlobals());

describe("deriveBlogBaseUrl", () => {
  it("reads the post directory off the sitemap", async () => {
    serve({
      "/sitemap.xml": sitemap([
        "https://altorank.co/",
        "https://altorank.co/pricing/",
        "https://altorank.co/blog/answer-engine-optimization/",
        "https://altorank.co/blog/how-to-get-cited-by-ai/",
        "https://altorank.co/blog/how-to-rank-in-chatgpt/",
      ]),
    });
    const r = await deriveBlogBaseUrl("https://altorank.co");
    expect(r?.baseUrl).toBe("https://altorank.co/blog");
    expect(r?.confidence).toBe("high");
  });

  // The bug this module exists to fix. altorank.co's own posts end in "/",
  // and the adapter was building the URL without one.
  it("carries the site's trailing-slash convention", async () => {
    serve({
      "/sitemap.xml": sitemap([
        "https://altorank.co/blog/one/",
        "https://altorank.co/blog/two/",
      ]),
    });
    expect((await deriveBlogBaseUrl("https://altorank.co"))?.trailingSlash).toBe(true);
  });

  it("reports no trailing slash when the site does not use one", async () => {
    serve({
      "/sitemap.xml": sitemap([
        "https://example.com/blog/one",
        "https://example.com/blog/two",
      ]),
    });
    expect((await deriveBlogBaseUrl("https://example.com"))?.trailingSlash).toBe(false);
  });

  it("prefers a named blog directory over a bigger anonymous one", async () => {
    serve({
      "/sitemap.xml": sitemap([
        ...Array.from({ length: 40 }, (_, i) => `https://shop.com/products/p${i}`),
        "https://shop.com/blog/hello",
        "https://shop.com/blog/world",
      ]),
    });
    const r = await deriveBlogBaseUrl("https://shop.com");
    expect(r?.baseUrl).toBe("https://shop.com/blog");
  });

  // gohugo.io has /functions/resources. An earlier BLOG_SEGMENTS list counted
  // "resources" as a blog word and returned that as high confidence.
  it("does not call a deep /resources directory a blog", async () => {
    serve({
      "/sitemap.xml": sitemap([
        "https://gohugo.io/functions/resources/bytype/",
        "https://gohugo.io/functions/resources/concat/",
        "https://gohugo.io/functions/resources/copy/",
      ]),
    });
    const r = await deriveBlogBaseUrl("https://gohugo.io");
    expect(r?.confidence).toBe("low");
    expect(r?.evidence).toMatch(/no \/blog-style directory/);
  });

  it("follows a sitemap index one level down", async () => {
    serve({
      "/sitemap.xml": sitemap(["https://example.com/sitemap-posts.xml"]),
      "sitemap-posts.xml": sitemap([
        "https://example.com/articles/a",
        "https://example.com/articles/b",
      ]),
    });
    expect((await deriveBlogBaseUrl("https://example.com"))?.baseUrl).toBe(
      "https://example.com/articles",
    );
  });

  it("prefers the sitemap robots.txt declares", async () => {
    serve({
      "/robots.txt": "User-agent: *\nSitemap: https://example.com/custom-sitemap.xml",
      "custom-sitemap.xml": sitemap(["https://example.com/news/launch"]),
    });
    expect((await deriveBlogBaseUrl("https://example.com"))?.baseUrl).toBe(
      "https://example.com/news",
    );
  });

  it("ignores URLs belonging to another origin", async () => {
    serve({
      "/sitemap.xml": sitemap([
        "https://cdn.other.com/blog/not-ours",
        "https://example.com/posts/ours",
      ]),
    });
    expect((await deriveBlogBaseUrl("https://example.com"))?.baseUrl).toBe(
      "https://example.com/posts",
    );
  });

  // A brand new site with nothing published is a real case, not an error. The
  // form asks instead of prefilling, which is better than inventing a prefix.
  it("returns null when there is no sitemap", async () => {
    serve({}, ["sitemap", "robots"]);
    expect(await deriveBlogBaseUrl("https://example.com")).toBeNull();
  });

  it("returns null when every page is top-level", async () => {
    serve({
      "/sitemap.xml": sitemap(["https://example.com/", "https://example.com/about"]),
    });
    expect(await deriveBlogBaseUrl("https://example.com")).toBeNull();
  });

  it("returns null for an unparseable site URL", async () => {
    serve({});
    expect(await deriveBlogBaseUrl("not a url")).toBeNull();
  });
});

describe("urlIsLive", () => {
  it("is true for a page that resolves", async () => {
    serve({ "/blog/hello": "<html>hi</html>" });
    expect(await urlIsLive("https://example.com/blog/hello")).toBe(true);
  });

  it("is false for a 404", async () => {
    serve({}, ["/blog/missing"]);
    expect(await urlIsLive("https://example.com/blog/missing")).toBe(false);
  });

  it("is false rather than throwing when the host is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect(await urlIsLive("https://nope.invalid/x")).toBe(false);
  });
});
