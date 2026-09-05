import { describe, it, expect, vi, beforeEach } from "vitest";
import { WordPressAdapter } from "../wordpress";
import { seoPluginMeta, SEO_META_KEYS } from "../wordpress-seo-meta";
import { remoteImageUrls, filenameFor } from "../remote-image";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const adapter = new WordPressAdapter({
  type: "wordpress",
  siteUrl: "https://example.com",
  username: "admin",
  applicationPassword: "secret",
});

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

// Braces matter: a hook that returns a function registers it as cleanup, and
// mockReset() returns the mock.
beforeEach(() => {
  mockFetch.mockReset();
});

describe("WordPressAdapter media import", () => {
  it("uploads inline and featured images to wp/v2/media and rewrites the post", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "https://cdn.altorank.test/inline.png") return png();
      if (url === "https://cdn.altorank.test/hero.png") return png();
      if (url === "https://example.com/wp-json/wp/v2/media") {
        const disposition = (init?.headers as Record<string, string>)["Content-Disposition"];
        const isHero = disposition.includes("hero.png");
        return Response.json({
          id: isHero ? 77 : 55,
          source_url: `https://example.com/wp-content/uploads/${isHero ? "hero" : "inline"}.png`,
        });
      }
      if (url === "https://example.com/wp-json/wp/v2/posts") {
        return Response.json({ id: 9, link: "https://example.com/post" });
      }
      throw new Error(`unexpected ${url}`);
    });

    const result = await adapter.publish({
      title: "With images",
      html: '<p>a</p><img src="https://cdn.altorank.test/inline.png" alt=""><img src="/local.png">',
      slug: "with-images",
      featuredImageUrl: "https://cdn.altorank.test/hero.png",
      metaDescription: "desc",
      focusKeyword: "kw",
    });

    expect(result).toEqual({ externalId: "9", url: "https://example.com/post" });

    const mediaCalls = mockFetch.mock.calls.filter(([u]) => u === "https://example.com/wp-json/wp/v2/media");
    expect(mediaCalls).toHaveLength(2);
    expect(mediaCalls[0][1].headers["Content-Type"]).toBe("image/png");
    expect(mediaCalls[0][1].headers["Content-Disposition"]).toBe('attachment; filename="inline.png"');

    const postCall = mockFetch.mock.calls.find(([u]) => u === "https://example.com/wp-json/wp/v2/posts")!;
    const body = JSON.parse(postCall[1].body);
    expect(body.content).toContain("https://example.com/wp-content/uploads/inline.png");
    expect(body.content).not.toContain("cdn.altorank.test");
    expect(body.content).toContain('<img src="/local.png">');
    expect(body.featured_media).toBe(77);
  });

  it("keeps the original URL and still publishes when an image cannot be fetched", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://cdn.altorank.test/gone.png") return new Response("", { status: 404 });
      if (url === "https://example.com/wp-json/wp/v2/posts") return Response.json({ id: 1, link: "https://example.com/p" });
      throw new Error(`unexpected ${url}`);
    });

    await adapter.publish({
      title: "Broken image",
      html: '<img src="https://cdn.altorank.test/gone.png">',
      slug: "broken",
    });

    const postCall = mockFetch.mock.calls.find(([u]) => u === "https://example.com/wp-json/wp/v2/posts")!;
    expect(JSON.parse(postCall[1].body).content).toContain("https://cdn.altorank.test/gone.png");
    expect(JSON.parse(postCall[1].body).featured_media).toBeUndefined();
  });

  it("refuses to upload a non-image response", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://cdn.altorank.test/page") return new Response("<html>", { headers: { "content-type": "text/html" } });
      if (url === "https://example.com/wp-json/wp/v2/posts") return Response.json({ id: 1, link: "x" });
      throw new Error(`unexpected ${url}`);
    });
    await adapter.publish({ title: "t", html: '<img src="https://cdn.altorank.test/page">', slug: "t" });
    expect(mockFetch.mock.calls.some(([u]) => u === "https://example.com/wp-json/wp/v2/media")).toBe(false);
  });
});

describe("WordPressAdapter SEO meta", () => {
  it("sends every SEO plugin's keys as post meta", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ id: 1, link: "https://example.com/p" }));
    await adapter.publish({ title: "Title", html: "<p>x</p>", slug: "s", metaDescription: "Desc", focusKeyword: "kw" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.meta).toEqual({
      rank_math_title: "Title",
      rank_math_description: "Desc",
      rank_math_focus_keyword: "kw",
      _yoast_wpseo_title: "Title",
      _yoast_wpseo_metadesc: "Desc",
      _yoast_wpseo_focuskw: "kw",
      _seopress_titles_title: "Title",
      _seopress_titles_desc: "Desc",
      _seopress_analysis_target_kw: "kw",
      _aioseo_title: "Title",
      _aioseo_description: "Desc",
      _aioseo_keyphrases: "kw",
    });
  });

  it("update() PUTs the same body to the existing post", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ id: 4, link: "https://example.com/p4" }));
    const result = await adapter.update("4", { title: "T2", html: "<p>y</p>", slug: "s" });
    expect(result).toEqual({ externalId: "4", url: "https://example.com/p4" });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/wp-json/wp/v2/posts/4");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body).status).toBe("publish");
  });
});

describe("seoPluginMeta", () => {
  it("omits empty values rather than writing empty strings", () => {
    const meta = seoPluginMeta({ title: "T" });
    expect(meta[SEO_META_KEYS.yoast.title]).toBe("T");
    expect(SEO_META_KEYS.yoast.description in meta).toBe(false);
    expect(SEO_META_KEYS.rankMath.focusKeyword in meta).toBe(false);
  });
});

describe("remote-image helpers", () => {
  it("remoteImageUrls() keeps only absolute images not on the destination host", () => {
    const html =
      '<img src="https://a.test/1.png"><img src="/2.png"><img src="https://example.com/3.png"><img src="https://a.test/1.png">';
    expect(remoteImageUrls(html, "example.com")).toEqual(["https://a.test/1.png"]);
  });

  it("filenameFor() derives a safe name with the right extension", () => {
    expect(filenameFor("https://a.test/path/My%20Photo.JPG", "image/jpeg")).toBe("My-Photo.JPG");
    expect(filenameFor("https://a.test/storage/v1/object/abc123", "image/webp")).toBe("abc123.webp");
    expect(filenameFor("https://a.test/", "image/png")).toBe("image.png");
  });
});
