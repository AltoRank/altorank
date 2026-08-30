import { describe, it, expect, vi, beforeEach } from "vitest";
import { WordPressAdapter } from "../wordpress";
import { ShopifyAdapter } from "../shopify";
import { MagentoAdapter } from "../magento";
import { WebflowAdapter } from "../webflow";
import { GhostAdapter } from "../ghost";
import { FramerAdapter } from "../framer";
import { WixAdapter } from "../wix";
import { NotionAdapter } from "../notion";
import { HubSpotAdapter } from "../hubspot";
import { WooCommerceAdapter } from "../woocommerce";
import { WebhookAdapter } from "../webhook";
import { resolveCMSAdapter } from "../adapter";
import { tiptapToHtml } from "../html";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// WordPress
// ---------------------------------------------------------------------------
describe("WordPressAdapter", () => {
  const adapter = new WordPressAdapter({
    type: "wordpress",
    siteUrl: "https://example.com",
    username: "admin",
    applicationPassword: "secret",
  });

  it("publish() sends POST and returns id + link", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, link: "https://example.com/hello-world" }),
    });

    const result = await adapter.publish({
      title: "Hello",
      html: "<p>world</p>",
      slug: "hello-world",
    });

    expect(result).toEqual({ externalId: "42", url: "https://example.com/hello-world" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/wp-json/wp/v2/posts");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toMatchObject({ title: "Hello", status: "publish" });
  });

  it("unpublish() sets status to draft (not DELETE)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await adapter.unpublish("42");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/wp-json/wp/v2/posts/42");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ status: "draft" });
  });

  it("unpublish() throws on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(adapter.unpublish("999")).rejects.toThrow("WordPress unpublish failed (404)");
  });

  it("testConnection() returns ok on success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });

  it("testConnection() returns error on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: false, error: "HTTP 401" });
  });
});

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
describe("ShopifyAdapter", () => {
  const adapter = new ShopifyAdapter({
    type: "shopify",
    storeUrl: "https://mystore.myshopify.com",
    accessToken: "shpat_xxx",
    blogId: "123",
  });

  it("publish() uses API response url field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        article: {
          id: 99,
          handle: "hello",
          url: "https://custom-domain.com/blogs/123/hello",
        },
      }),
    });

    const result = await adapter.publish({
      title: "Hello",
      html: "<p>world</p>",
      slug: "hello",
    });

    expect(result.url).toBe("https://custom-domain.com/blogs/123/hello");
    expect(result.externalId).toBe("99");
  });

  it("publish() falls back to constructed url if api url missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        article: { id: 99, handle: "hello" },
      }),
    });

    const result = await adapter.publish({
      title: "Hello",
      html: "<p>world</p>",
      slug: "hello",
    });

    expect(result.url).toBe("https://mystore.myshopify.com/blogs/123/hello");
  });

  it("publish() uses 2025-01 API version", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        article: { id: 1, handle: "x", url: "https://x.com/blogs/123/x" },
      }),
    });

    await adapter.publish({ title: "T", html: "<p>h</p>", slug: "t" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/admin/api/2025-01/");
  });

  it("unpublish() sends DELETE", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.unpublish("99");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("DELETE");
    expect(url).toContain("/articles/99.json");
  });

  it("testConnection() checks blogs endpoint", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
    expect(mockFetch.mock.calls[0][0]).toContain("/blogs.json");
  });

  it("resolveBlogId() fetches from API when blogId not set", async () => {
    const noBlogAdapter = new ShopifyAdapter({
      type: "shopify",
      storeUrl: "https://mystore.myshopify.com",
      accessToken: "shpat_xxx",
    });

    // First call: resolveBlogId fetches blogs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ blogs: [{ id: 456 }] }),
    });
    // Second call: actual publish
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        article: { id: 1, handle: "x", url: "https://x.com/blogs/456/x" },
      }),
    });

    await noBlogAdapter.publish({ title: "T", html: "<p>h</p>", slug: "t" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain("/blogs/456/");
  });
});

// ---------------------------------------------------------------------------
// Magento
// ---------------------------------------------------------------------------
describe("MagentoAdapter", () => {
  const adapter = new MagentoAdapter({
    type: "magento",
    baseUrl: "https://magento.example.com",
    adminToken: "tok123",
  });

  it("publish() creates CMS page and returns url", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 7 }),
    });

    const result = await adapter.publish({
      title: "About Us",
      html: "<p>We are cool</p>",
      slug: "about-us",
    });

    expect(result).toEqual({
      externalId: "7",
      url: "https://magento.example.com/about-us",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/V1/cmsPage");
    const body = JSON.parse(opts.body);
    expect(body.page.identifier).toBe("about-us");
    expect(body.page.active).toBe(true);
  });

  it("unpublish() sends DELETE", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.unpublish("7");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("DELETE");
    expect(url).toContain("/V1/cmsPage/7");
  });

  it("uses custom storeCode when provided", async () => {
    const customAdapter = new MagentoAdapter({
      type: "magento",
      baseUrl: "https://m.example.com",
      adminToken: "tok",
      storeCode: "fr_store",
    });

    mockFetch.mockResolvedValueOnce({ ok: true });
    await customAdapter.testConnection();

    expect(mockFetch.mock.calls[0][0]).toContain("/rest/fr_store/");
  });

  it("testConnection() returns ok on success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// resolveCMSAdapter
// ---------------------------------------------------------------------------
describe("resolveCMSAdapter", () => {
  it("resolves wordpress adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "wordpress",
      siteUrl: "https://x.com",
      username: "u",
      applicationPassword: "p",
    });
    expect(adapter).toBeInstanceOf(WordPressAdapter);
  });

  it("resolves shopify adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "shopify",
      storeUrl: "https://x.myshopify.com",
      accessToken: "t",
    });
    expect(adapter).toBeInstanceOf(ShopifyAdapter);
  });

  it("resolves magento adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "magento",
      baseUrl: "https://m.example.com",
      adminToken: "t",
    });
    expect(adapter).toBeInstanceOf(MagentoAdapter);
  });

  it("resolves webflow adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "webflow",
      siteId: "s1",
      collectionId: "c1",
      apiToken: "t",
    });
    expect(adapter).toBeInstanceOf(WebflowAdapter);
  });

  it("resolves ghost adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "ghost",
      apiUrl: "https://ghost.example.com",
      adminApiKey: "id:secret",
    });
    expect(adapter).toBeInstanceOf(GhostAdapter);
  });

  it("resolves framer adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "framer",
      siteId: "s1",
      collectionId: "c1",
      apiToken: "t",
    });
    expect(adapter).toBeInstanceOf(FramerAdapter);
  });

  it("resolves wix adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "wix",
      accountId: "a1",
      siteId: "s1",
      apiKey: "k",
    });
    expect(adapter).toBeInstanceOf(WixAdapter);
  });

  it("resolves notion adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "notion",
      integrationToken: "t",
      parentPageId: "p1",
    });
    expect(adapter).toBeInstanceOf(NotionAdapter);
  });

  it("resolves hubspot adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "hubspot",
      accessToken: "t",
    });
    expect(adapter).toBeInstanceOf(HubSpotAdapter);
  });

  it("resolves woocommerce adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "woocommerce",
      siteUrl: "https://woo.example.com",
      username: "u",
      applicationPassword: "p",
    });
    expect(adapter).toBeInstanceOf(WooCommerceAdapter);
  });

  it("resolves webhook adapter", () => {
    const adapter = resolveCMSAdapter({
      type: "webhook",
      url: "https://hook.example.com/publish",
    });
    expect(adapter).toBeInstanceOf(WebhookAdapter);
  });

  it("throws on unknown type", () => {
    expect(() =>
      resolveCMSAdapter({ type: "unknown_cms" } as never)
    ).toThrow("Unsupported CMS type: unknown_cms");
  });
});

// ---------------------------------------------------------------------------
// tiptapToHtml
// ---------------------------------------------------------------------------
describe("tiptapToHtml", () => {
  it("renders paragraphs", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
      ],
    });
    expect(html).toBe("<p>Hello world</p>");
  });

  it("renders headings", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
      ],
    });
    expect(html).toBe("<h2>Title</h2>");
  });

  it("renders bold and italic marks", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
          ],
        },
      ],
    });
    expect(html).toBe("<p><strong>bold</strong> and <em>italic</em></p>");
  });

  it("renders underline mark", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "underlined", marks: [{ type: "underline" }] }],
        },
      ],
    });
    expect(html).toBe("<p><u>underlined</u></p>");
  });

  it("renders strikethrough mark", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "deleted", marks: [{ type: "strike" }] }],
        },
      ],
    });
    expect(html).toBe("<p><s>deleted</s></p>");
  });

  it("renders images", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://example.com/img.png", alt: "A photo" } },
      ],
    });
    expect(html).toBe('<img src="https://example.com/img.png" alt="A photo" />');
  });

  it("renders images with title", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "https://x.com/i.jpg", alt: "alt", title: "My Title" },
        },
      ],
    });
    expect(html).toContain('title="My Title"');
  });

  it("renders links", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    });
    expect(html).toBe('<p><a href="https://example.com">click</a></p>');
  });

  it("renders bullet lists", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
      ],
    });
    expect(html).toContain("<ul>");
    expect(html).toContain("<li><p>one</p>");
    expect(html).toContain("<li><p>two</p>");
  });

  it("renders tables", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Age" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Alice" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "30" }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toContain("<table>");
    expect(html).toContain("<th><p>Name</p>");
    expect(html).toContain("<td><p>Alice</p>");
  });

  it("escapes HTML entities in text", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "<script>alert('xss')</script>" }] },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders code blocks", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: "const x = 1;" }] },
      ],
    });
    expect(html).toBe("<pre><code>const x = 1;</code></pre>");
  });

  it("renders blockquotes", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "A quote" }] }],
        },
      ],
    });
    expect(html).toContain("<blockquote><p>A quote</p>");
  });

  it("renders horizontal rules", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [{ type: "horizontalRule" }],
    });
    expect(html).toBe("<hr />");
  });
});

// ---------------------------------------------------------------------------
// Webflow
// ---------------------------------------------------------------------------
describe("WebflowAdapter", () => {
  const adapter = new WebflowAdapter({
    type: "webflow",
    siteId: "site_abc",
    collectionId: "col_abc",
    apiToken: "wf_token",
  });

  it("publish() sends POST to collection items endpoint", async () => {
    // First call: create item
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "item_1", fieldData: { slug: "hello" } }),
    });
    // Second call: publish item live
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await adapter.publish({
      title: "Hello",
      html: "<p>world</p>",
      slug: "hello",
    });

    expect(result.externalId).toBe("item_1");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/collections/col_abc/items");
    expect(opts.method).toBe("POST");
  });

  it("unpublish() uses PATCH to archive", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.unpublish("item_1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("PATCH");
    expect(url).toContain("/items/item_1");
    expect(JSON.parse(opts.body).fieldData._archived).toBe(true);
  });

  it("testConnection() checks collections endpoint", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });

  it("uses Bearer auth", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.testConnection();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer wf_token");
  });
});

// ---------------------------------------------------------------------------
// Framer
// ---------------------------------------------------------------------------
describe("FramerAdapter", () => {
  const adapter = new FramerAdapter({
    type: "framer",
    siteId: "site_framer",
    collectionId: "col_framer",
    apiToken: "framer_tok",
  });

  it("publish() sends POST to collection items", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "f_item_1", slug: "test" }),
    });

    const result = await adapter.publish({
      title: "Test",
      html: "<p>content</p>",
      slug: "test",
    });

    expect(result.externalId).toBe("f_item_1");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/collections/col_framer/items");
    expect(opts.method).toBe("POST");
  });

  it("unpublish() uses PATCH to set isDraft", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.unpublish("f_item_1");
    expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).isDraft).toBe(true);
  });

  it("testConnection() returns ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------
describe("HubSpotAdapter", () => {
  const adapter = new HubSpotAdapter({
    type: "hubspot",
    accessToken: "hs_token",
    blogId: "blog_123",
  });

  it("publish() sends POST to blog posts endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "post_1", url: "https://blog.example.com/post" }),
    });

    const result = await adapter.publish({
      title: "HubSpot Post",
      html: "<p>content</p>",
      slug: "hubspot-post",
    });

    expect(result.externalId).toBe("post_1");
    expect(result.url).toBe("https://blog.example.com/post");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/cms/v3/blogs/posts");
  });

  it("unpublish() uses PATCH to set DRAFT", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.unpublish("post_1");
    expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).currentState).toBe("DRAFT");
  });

  it("testConnection() returns ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });

  it("uses Bearer auth", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await adapter.testConnection();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer hs_token");
  });
});

// ---------------------------------------------------------------------------
// WooCommerce
// ---------------------------------------------------------------------------
describe("WooCommerceAdapter", () => {
  const adapter = new WooCommerceAdapter({
    type: "woocommerce",
    siteUrl: "https://woo.example.com",
    username: "admin",
    applicationPassword: "secret",
  });

  it("publish() sends POST to wp posts endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 55, link: "https://woo.example.com/post-55" }),
    });

    const result = await adapter.publish({
      title: "WooCommerce Post",
      html: "<p>product content</p>",
      slug: "woo-post",
    });

    expect(result.externalId).toBe("55");
    expect(result.url).toBe("https://woo.example.com/post-55");
  });

  it("uses basic auth with base64 encoding", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, link: "https://x.com/y" }),
    });

    await adapter.publish({
      title: "T",
      html: "<p>h</p>",
      slug: "t",
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    const expectedAuth = "Basic " + Buffer.from("admin:secret").toString("base64");
    expect(headers.Authorization).toBe(expectedAuth);
  });

  it("unpublish() sets status to draft", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await adapter.unpublish("55");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ status: "draft" });
  });

  it("testConnection() returns ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
describe("WebhookAdapter", () => {
  const adapter = new WebhookAdapter({
    type: "webhook",
    url: "https://hook.example.com/publish",
  });

  it("publish() sends POST with payload", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "hook_1" }),
    });

    const result = await adapter.publish({
      title: "Webhook Post",
      html: "<p>content</p>",
      slug: "webhook-post",
    });

    expect(result.externalId).toBe("hook_1");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hook.example.com/publish");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.action).toBe("publish");
    expect(body.article.title).toBe("Webhook Post");
  });

  it("unpublish() sends POST with unpublish action", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await adapter.unpublish("hook_1");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.action).toBe("unpublish");
    expect(body.externalId).toBe("hook_1");
  });

  it("testConnection() returns ok on 2xx", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true });
  });

  it("includes HMAC signature when secret is set", async () => {
    const signedAdapter = new WebhookAdapter({
      type: "webhook",
      url: "https://hook.example.com/publish",
      secret: "mysecret",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "s1" }),
    });

    await signedAdapter.publish({
      title: "Signed",
      html: "<p>s</p>",
      slug: "signed",
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["X-Webhook-Signature"]).toBeDefined();
    expect(headers["X-Webhook-Signature"].startsWith("sha256=")).toBe(true);
  });
});
