import { describe, it, expect, vi, beforeEach } from "vitest";
import { WordPressPluginAdapter, pluginInstallUrl, MIN_PLUGIN_VERSION, TOKEN_HEADER } from "../wordpress-plugin";
import { compareVersions } from "../wordpress-plugin-install";
import { resolveCMSAdapter } from "../adapter";

// Every request the adapter makes goes through siteFetch (its address policy
// has its own tests in site-fetch.test.ts); here it is the network.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../site-fetch", () => ({
  siteFetch: (...args: unknown[]) => mockFetch(...args),
  assertSiteUrl: () => {},
}));

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
      publishedAt: "2026-09-20T08:00:00.000Z",
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
      published_at: "2026-09-20T08:00:00.000Z",
      status: "publish",
    });
    // The draft's creation time is not a publication date.
    expect(JSON.parse(opts.body)).not.toHaveProperty("created_at");
  });

  it("publish() hands the plugin the workspace's IndexNow key, and omits it when there is none", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ id: 1, url: "https://example.com/a", status: "publish", indexnow_key_location: null }, { status: 201 }),
    );
    await adapter.publish({ id: "art-2", title: "A", html: "<p>a</p>", slug: "a", indexNowKey: "k1234567" });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ indexnow_key: "k1234567" });

    mockFetch.mockResolvedValueOnce(Response.json({ id: 2, url: "https://example.com/b", status: "publish" }, { status: 201 }));
    await adapter.publish({ id: "art-3", title: "B", html: "<p>b</p>", slug: "b", indexNowKey: null });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).not.toHaveProperty("indexnow_key");
  });

  it("publish() passes on where the plugin serves the IndexNow key", async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        { id: 5, url: "https://example.com/blog/a", status: "publish", indexnow_key_location: "https://example.com/blog/k1234567.txt" },
        { status: 201 },
      ),
    );
    const result = await adapter.publish({ id: "art-5", title: "A", html: "<p>a</p>", slug: "a", indexNowKey: "k1234567" });
    expect(result.indexNowKeyLocation).toBe("https://example.com/blog/k1234567.txt");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("publish() asks an older plugin's /indexnow for the key location", async () => {
    mockFetch
      .mockResolvedValueOnce(Response.json({ id: 6, url: "https://example.com/blog/b", status: "publish" }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ key: "k1234567", key_location: "https://example.com/blog/k1234567.txt" }));
    const result = await adapter.publish({ id: "art-6", title: "B", html: "<p>b</p>", slug: "b", indexNowKey: "k1234567" });
    expect(result.indexNowKeyLocation).toBe("https://example.com/blog/k1234567.txt");
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe("https://example.com/wp-json/altorank/v1/indexnow");
    expect(opts.headers[TOKEN_HEADER]).toBe(TOKEN);
  });

  it("publish() ignores a reported location for a different key, and asks nothing without a key or for a draft", async () => {
    mockFetch
      .mockResolvedValueOnce(Response.json({ id: 7, url: "https://example.com/c", status: "publish" }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ key: "other-key", key_location: "https://example.com/other-key.txt" }));
    const stale = await adapter.publish({ id: "art-7", title: "C", html: "<p>c</p>", slug: "c", indexNowKey: "k1234567" });
    expect(stale.indexNowKeyLocation).toBeUndefined();

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(Response.json({ id: 8, url: "https://example.com/d", status: "publish" }, { status: 201 }));
    expect((await adapter.publish({ id: "art-8", title: "D", html: "<p>d</p>", slug: "d" })).indexNowKeyLocation).toBeUndefined();
    mockFetch.mockResolvedValueOnce(Response.json({ id: 9, url: "", status: "draft" }, { status: 201 }));
    await adapter.publish({ id: "art-9", title: "E", html: "<p>e</p>", slug: "e", indexNowKey: "k1234567" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("post addresses from the site are kept only when they are http(s) URLs", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "not a url", 42]) {
      mockFetch.mockResolvedValueOnce(Response.json({ id: 20, url, status: "draft" }, { status: 201 }));
      expect((await adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" })).url).toBe("");
    }
    mockFetch.mockResolvedValueOnce(
      Response.json({ posts: [{ id: 1, title: "A", slug: "a", url: "javascript:void(0)", status: "publish", modified: "" }] }),
    );
    expect((await adapter.listPosts())[0].url).toBe("");
    mockFetch.mockResolvedValueOnce(Response.json({ id: 21, url: "http://example.com/caf%C3%A9/", status: "draft" }, { status: 201 }));
    expect((await adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" })).url).toBe("http://example.com/caf%C3%A9/");
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

  it("a failure repeats only the plugin's own error message, cut short", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: "altorank_bad_request", message: `title and\n content ${"x".repeat(400)}` }), { status: 400 }),
    );
    const err = (await adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^WordPress plugin publish failed \(400\): title and content x+…$/);
    expect(err.message.length).toBeLessThan(260);
  });

  it("a failure that is not a WordPress REST error repeats nothing from the body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("<html><body>internal admin page secret</body></html>", { status: 400 }));
    const err = (await adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("WordPress plugin publish failed (400)");

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: "no code field" }), { status: 400 }));
    const plain = await adapter.testConnection();
    expect(plain).toEqual({ ok: false, error: "WordPress plugin test failed (400)" });
  });

  it("a redirect is reported, not followed", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "http://10.0.0.1/" } }));
    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/\(301\): the site answered with a redirect/);
    expect(res.error).not.toContain("10.0.0.1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  it("update() without an article id names the post by its WordPress id only", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ id: 12, url: "https://example.com/hello", status: "publish" }));
    await adapter.update("12", { title: "Hello 2", html: "<p>v2</p>", slug: "hello" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.post_id).toBe("12");
    expect(body).not.toHaveProperty("external_id");
    expect(body).not.toHaveProperty("status");
  });

  it("update() sends no date, so the post keeps the one it has", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ id: 12, url: "https://example.com/hello", status: "publish" }));
    await adapter.update("12", {
      id: "art-1",
      title: "Hello 2",
      html: "<p>v2</p>",
      slug: "hello",
      createdAt: "2026-09-04T10:00:00.000Z",
      publishedAt: "2026-09-20T08:00:00.000Z",
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("published_at");
    expect(body).not.toHaveProperty("created_at");
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
    mockFetch.mockResolvedValueOnce(Response.json({ ok: true, version: MIN_PLUGIN_VERSION }));
    expect(await adapter.testConnection()).toEqual({ ok: true });
    expect(mockFetch.mock.calls[0][0]).toBe("https://example.com/wp-json/altorank/v1/test-integration");

    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const bad = await adapter.testConnection();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/token does not match/);

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await adapter.testConnection()).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("testConnection() refuses a plugin older than the minimum, saying how to update", async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ ok: true, version: "1.1.0" }));
    const old = await adapter.testConnection();
    expect(old.ok).toBe(false);
    expect(old.error).toContain("version 1.1.0");
    expect(old.error).toContain(`version ${MIN_PLUGIN_VERSION} or later is required`);
    expect(old.error).toContain("Replace current with uploaded");

    mockFetch.mockResolvedValueOnce(Response.json({ ok: true }));
    expect((await adapter.testConnection()).ok).toBe(false);

    mockFetch.mockResolvedValueOnce(Response.json({ ok: true, version: "1.10.0" }));
    expect(await adapter.testConnection()).toEqual({ ok: true });
  });

  it("is resolved by resolveCMSAdapter for type wordpress-plugin", () => {
    expect(
      resolveCMSAdapter({ type: "wordpress-plugin", siteUrl: "https://x.example", token: TOKEN }),
    ).toBeInstanceOf(WordPressPluginAdapter);
  });
});

describe("compareVersions", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("1.1.0", "1.1.1")).toBe(-1);
    expect(compareVersions("1.1.1", "1.1.1")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2", "1.9.9")).toBe(1);
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
  });
});

describe("pluginInstallUrl", () => {
  it("deep-links to the Upload Plugin tab of the customer's own admin", () => {
    expect(pluginInstallUrl("https://example.com/")).toBe("https://example.com/wp-admin/plugin-install.php?tab=upload");
  });
  it("never sends the person to a wordpress.org search: the plugin is not listed there", () => {
    expect(pluginInstallUrl("https://example.com")).not.toContain("tab=search");
    expect(pluginInstallUrl("https://example.com")).not.toContain("s=altorank");
  });
});
