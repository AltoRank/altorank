import { describe, it, expect, vi, beforeEach } from "vitest";
import { WordPressPluginAdapter, pluginInstallUrl, TOKEN_HEADER } from "../wordpress-plugin";
import { resolveCMSAdapter } from "../adapter";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TOKEN = "a".repeat(64);
const adapter = new WordPressPluginAdapter({
  type: "wordpress-plugin",
  siteUrl: "https://example.com/",
  token: TOKEN,
});

// Braces matter: a hook that returns a function registers it as cleanup, and
// mockReset() returns the mock.
beforeEach(() => {
  mockFetch.mockReset();
});

describe("WordPressPluginAdapter", () => {
  it("publish() POSTs /submit with the token in a header, never the URL", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ id: 12, url: "https://example.com/hello", slug: "hello", status: "publish" }, { status: 201 }),
    );

    const result = await adapter.publish({
      id: "art-1",
      title: "Hello",
      html: "<p>hi</p>",
      slug: "hello",
      metaDescription: "desc",
      focusKeyword: "hello world",
      featuredImageUrl: "https://img.example/x.png",
      tags: ["a", "b"],
      createdAt: "2026-09-04T10:00:00.000Z",
    });

    expect(result).toEqual({ externalId: "12", url: "https://example.com/hello", status: "publish" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/wp-json/altorank/v1/submit");
    expect(url).not.toContain(TOKEN);
    expect(opts.method).toBe("POST");
    expect(opts.headers[TOKEN_HEADER]).toBe(TOKEN);
    expect(JSON.parse(opts.body)).toMatchObject({
      external_id: "art-1",
      title: "Hello",
      content: "<p>hi</p>",
      slug: "hello",
      meta_description: "desc",
      focus_keyword: "hello world",
      featured_image_url: "https://img.example/x.png",
      tags: ["a", "b"],
      created_at: "2026-09-04T10:00:00.000Z",
      status: "publish",
    });
  });

  it("publish() reports when the site held the post as a draft", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ id: 13, url: "https://example.com/?p=13", status: "draft" }, { status: 201 }),
    );
    const result = await adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" });
    expect(result.status).toBe("draft");
  });

  it("publish() explains a 403 as a token mismatch", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "altorank_forbidden", message: "Invalid integration token." }), { status: 403 }),
    );
    await expect(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" })).rejects.toThrow(
      /403.*token does not match/,
    );
  });

  it("publish() explains a 404 as plugin not installed", async () => {
    mockFetch.mockResolvedValueOnce(new Response("rest_no_route", { status: 404 }));
    await expect(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" })).rejects.toThrow(
      /not installed or not activated/,
    );
  });

  it("update() PUTs /edit naming the existing post", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ id: 12, url: "https://example.com/hello", status: "publish" }));
    const result = await adapter.update("12", { id: "art-1", title: "Hello 2", html: "<p>v2</p>", slug: "hello" });
    expect(result.externalId).toBe("12");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/wp-json/altorank/v1/edit");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toMatchObject({ post_id: "12", external_id: "art-1", title: "Hello 2" });
  });

  it("unpublish() sets the post back to draft through /edit", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ id: 12, url: "", status: "draft" }));
    await adapter.unpublish("12");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/altorank/v1/edit");
    expect(JSON.parse(opts.body)).toEqual({ post_id: "12", status: "draft" });
  });

  it("listPosts() reads /posts with paging and maps the rows", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({
        posts: [{ id: 1, title: "A", slug: "a", url: "https://example.com/a", status: "publish", modified: "2026-09-01T00:00:00+00:00" }],
        total: 1,
      }),
    );
    const posts = await adapter.listPosts({ page: 2, perPage: 10, status: "publish" });
    expect(posts).toEqual([
      { externalId: "1", title: "A", slug: "a", url: "https://example.com/a", status: "publish", modifiedAt: "2026-09-01T00:00:00+00:00" },
    ]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/wp-json/altorank/v1/posts?page=2&per_page=10&status=publish");
    expect(opts.headers[TOKEN_HEADER]).toBe(TOKEN);
  });

  it("testConnection() POSTs /test-integration and reports the outcome", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await adapter.testConnection()).toEqual({ ok: true });
    expect(mockFetch.mock.calls[0][0]).toBe("https://example.com/wp-json/altorank/v1/test-integration");

    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const bad = await adapter.testConnection();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/token does not match/);

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await adapter.testConnection()).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("is resolved by resolveCMSAdapter for type wordpress-plugin", () => {
    expect(
      resolveCMSAdapter({ type: "wordpress-plugin", siteUrl: "https://x.example", token: TOKEN }),
    ).toBeInstanceOf(WordPressPluginAdapter);
  });
});

describe("pluginInstallUrl", () => {
  it("deep-links into the customer's own plugin installer", () => {
    expect(pluginInstallUrl("https://example.com/")).toBe(
      "https://example.com/wp-admin/plugin-install.php?s=altorank&tab=search&type=term",
    );
  });
});
