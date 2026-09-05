/**
 * The connect dialog's pickers: what a token can see, and how a collection's
 * own fields become the article's field map. Pure logic and request shaping
 * only - fetch is mocked, no vendor is called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WebflowAdapter,
  listWebflowSites,
  listWebflowCollections,
  listWebflowFields,
  webflowFieldData,
} from "../webflow";
import {
  DEFAULT_WEBFLOW_FIELD_MAP,
  candidatesFor,
  describeWebflowFieldMap,
  parseWebflowFieldMap,
  suggestWebflowFieldMap,
  type WebflowFieldLike,
} from "../webflow-fields";
import { listWixSites } from "../wix";
import { ShopifyAdapter, SHOPIFY_REQUIRED_SCOPES, listShopifyBlogs } from "../shopify";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Field-map suggestion
// ---------------------------------------------------------------------------

const templateFields: WebflowFieldLike[] = [
  { slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
  { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
  { slug: "post-body", displayName: "Post Body", type: "RichText" },
  { slug: "post-summary", displayName: "Post Summary", type: "PlainText" },
  { slug: "main-image", displayName: "Main Image", type: "Image" },
  { slug: "thumbnail-image", displayName: "Thumbnail image", type: "Image" },
  { slug: "featured", displayName: "Featured?", type: "Switch" },
  { slug: "color", displayName: "Color", type: "Color" },
];

describe("suggestWebflowFieldMap", () => {
  it("maps Webflow's blog template to the slugs the adapter always used", () => {
    const { map, missing } = suggestWebflowFieldMap(templateFields);
    expect(missing).toEqual([]);
    expect(map).toEqual({ ...DEFAULT_WEBFLOW_FIELD_MAP, image: "main-image" });
  });

  it("finds a hand-built collection's fields by type and name hints", () => {
    const fields: WebflowFieldLike[] = [
      { slug: "title", displayName: "Title", type: "PlainText", isRequired: true },
      { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
      { slug: "author-bio", displayName: "Author bio", type: "RichText" },
      { slug: "content", displayName: "Content", type: "RichText" },
      { slug: "seo-description", displayName: "SEO description", type: "PlainText" },
      { slug: "cover", displayName: "Cover", type: "Image" },
    ];
    const { map } = suggestWebflowFieldMap(fields);
    expect(map).toEqual({
      title: "title",
      slug: "slug",
      body: "content",
      summary: "seo-description",
      image: "cover",
    });
  });

  it("claims the slug field before the title so a PlainText 'slug' is never the title", () => {
    const fields: WebflowFieldLike[] = [
      { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
      { slug: "headline", displayName: "Headline", type: "PlainText", isRequired: true },
      { slug: "body", displayName: "Body", type: "RichText" },
    ];
    const { map } = suggestWebflowFieldMap(fields);
    expect(map).toMatchObject({ title: "headline", slug: "slug", body: "body" });
  });

  it("returns no map and names the gap when the collection has no RichText field", () => {
    const fields: WebflowFieldLike[] = [
      { slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
      { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
      { slug: "price", displayName: "Price", type: "Number" },
    ];
    const { map, missing } = suggestWebflowFieldMap(fields);
    expect(map).toBeNull();
    expect(missing).toEqual(["body"]);
  });

  it("leaves summary and image out rather than guessing when nothing fits", () => {
    const fields: WebflowFieldLike[] = [
      { slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
      { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
      { slug: "post-body", displayName: "Post Body", type: "RichText" },
    ];
    const { map } = suggestWebflowFieldMap(fields);
    expect(map).toEqual({ title: "name", slug: "slug", body: "post-body" });
    expect(map && "summary" in map).toBe(false);
  });

  it("skips fields Webflow marks not editable", () => {
    const fields: WebflowFieldLike[] = [
      { slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
      { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
      { slug: "computed", displayName: "Computed body", type: "RichText", isEditable: false },
      { slug: "post-body", displayName: "Post Body", type: "RichText" },
    ];
    expect(candidatesFor("body", fields).map((f) => f.slug)).toEqual(["post-body"]);
  });
});

describe("parseWebflowFieldMap / describeWebflowFieldMap", () => {
  it("accepts the required three and trims", () => {
    expect(parseWebflowFieldMap({ title: " name ", slug: "slug", body: "post-body", summary: "" })).toEqual({
      title: "name",
      slug: "slug",
      body: "post-body",
    });
  });

  it("rejects a map missing a required role", () => {
    expect(parseWebflowFieldMap({ title: "name", slug: "slug" })).toBeNull();
    expect(parseWebflowFieldMap("nope")).toBeNull();
    expect(parseWebflowFieldMap(null)).toBeNull();
  });

  it("describes what will be sent, in role order", () => {
    expect(describeWebflowFieldMap({ title: "name", slug: "slug", body: "content", image: "cover" })).toBe(
      "Title → name · Slug → slug · Article body → content · Featured image → cover",
    );
  });
});

// ---------------------------------------------------------------------------
// Field data shaping and the adapter's use of the map
// ---------------------------------------------------------------------------

describe("webflowFieldData", () => {
  const article = {
    title: "Hello",
    html: "<p>hi</p>",
    slug: "hello",
    metaDescription: "A greeting",
    featuredImageUrl: "https://img.example/x.jpg",
  };

  it("writes each part to its mapped slug, image as { url }", () => {
    expect(
      webflowFieldData({ title: "t", slug: "s", body: "b", summary: "m", image: "i" }, article, {
        includeSlug: true,
      }),
    ).toEqual({
      t: "Hello",
      s: "hello",
      b: "<p>hi</p>",
      m: "A greeting",
      i: { url: "https://img.example/x.jpg" },
    });
  });

  it("omits slug on update and omits roles that are not mapped", () => {
    expect(webflowFieldData({ title: "t", slug: "s", body: "b" }, article, { includeSlug: false })).toEqual({
      t: "Hello",
      b: "<p>hi</p>",
    });
  });

  it("does not send an image field when the article has no image", () => {
    const data = webflowFieldData(
      { title: "t", slug: "s", body: "b", image: "i" },
      { ...article, featuredImageUrl: undefined },
      { includeSlug: true },
    );
    expect("i" in data).toBe(false);
  });
});

describe("WebflowAdapter with a field map", () => {
  it("publishes to the mapped slugs", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ id: "item1" }))
      .mockResolvedValueOnce(okJson({}));
    const adapter = new WebflowAdapter({
      type: "webflow",
      siteId: "site",
      collectionId: "col",
      apiToken: "tok",
      fieldMap: { title: "headline", slug: "slug", body: "content" },
    });
    await adapter.publish({ title: "Hi", html: "<p>x</p>", slug: "hi", metaDescription: "m" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.fieldData).toEqual({ headline: "Hi", slug: "hi", content: "<p>x</p>" });
  });

  it("keeps the template slugs when a connection predates the picker", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ id: "item1" }))
      .mockResolvedValueOnce(okJson({}));
    const adapter = new WebflowAdapter({ type: "webflow", siteId: "site", collectionId: "col", apiToken: "tok" });
    await adapter.publish({ title: "Hi", html: "<p>x</p>", slug: "hi", metaDescription: "m" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.fieldData).toEqual({ name: "Hi", slug: "hi", "post-body": "<p>x</p>", "post-summary": "m" });
  });
});

// ---------------------------------------------------------------------------
// Discovery requests
// ---------------------------------------------------------------------------

describe("Webflow discovery", () => {
  it("lists sites with a bearer token", async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        sites: [
          { id: "s1", displayName: "Acme", shortName: "acme", customDomains: [{ id: "d", url: "acme.com" }] },
          { id: "s2", shortName: "beta" },
        ],
      }),
    );
    const sites = await listWebflowSites("tok");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.webflow.com/v2/sites");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(sites).toEqual([
      { id: "s1", displayName: "Acme", shortName: "acme", customDomains: ["acme.com"] },
      { id: "s2", displayName: "beta", shortName: "beta", customDomains: [] },
    ]);
  });

  it("lists a site's collections", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ collections: [{ id: "c1", displayName: "Blog Posts", singularName: "Blog Post", slug: "post" }] }));
    const cols = await listWebflowCollections("tok", "s1");
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.webflow.com/v2/sites/s1/collections");
    expect(cols).toEqual([{ id: "c1", displayName: "Blog Posts", singularName: "Blog Post", slug: "post" }]);
  });

  it("reads a collection's fields, defaulting isRequired false and isEditable true", async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({ fields: [{ id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }, { id: "f2", slug: "post-body", type: "RichText" }] }),
    );
    const fields = await listWebflowFields("tok", "c1");
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.webflow.com/v2/collections/c1");
    expect(fields).toEqual([
      { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true, isEditable: true },
      { id: "f2", slug: "post-body", displayName: "post-body", type: "RichText", isRequired: false, isEditable: true },
    ]);
  });

  it("surfaces Webflow's own error text", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' });
    await expect(listWebflowSites("bad")).rejects.toThrow('Webflow 401: {"message":"Unauthorized"}');
  });
});

describe("Wix discovery", () => {
  it("queries the account's site list with the account header and no site header", async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({ sites: [{ id: "site-1", displayName: "Shop", viewUrl: "https://shop.example", published: true }, { id: "site-2", name: "draft-site" }] }),
    );
    const sites = await listWixSites("key", "acct");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://www.wixapis.com/site-list/v2/sites/query");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toMatchObject({ Authorization: "key", "wix-account-id": "acct" });
    expect(opts.headers["wix-site-id"]).toBeUndefined();
    expect(JSON.parse(opts.body)).toEqual({
      query: { cursorPaging: { limit: 100 }, sort: [{ fieldName: "displayName", order: "ASC" }] },
    });
    expect(sites).toEqual([
      { id: "site-1", displayName: "Shop", viewUrl: "https://shop.example", published: true },
      { id: "site-2", displayName: "draft-site", viewUrl: "", published: false },
    ]);
  });

  it("surfaces Wix's error text", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "PERMISSION_DENIED" });
    await expect(listWixSites("key", "acct")).rejects.toThrow("Wix 403: PERMISSION_DENIED");
  });
});

describe("Shopify discovery", () => {
  it("asks for exactly the content scope pair", () => {
    expect([...SHOPIFY_REQUIRED_SCOPES]).toEqual(["read_content", "write_content"]);
  });

  it("lists blogs with the access-token header", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ blogs: [{ id: 1, title: "News", handle: "news" }] }));
    const blogs = await listShopifyBlogs("https://s.myshopify.com/", "tok");
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://s.myshopify.com/admin/api/2025-01/blogs.json");
    expect(opts.headers["X-Shopify-Access-Token"]).toBe("tok");
    expect(blogs).toEqual([{ id: "1", title: "News", handle: "news" }]);
  });

  it("the adapter resolves its default blog through the same listing", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ blogs: [{ id: 7, title: "Blog" }] }))
      .mockResolvedValueOnce(okJson({ article: { id: 99, handle: "hi" } }));
    const adapter = new ShopifyAdapter({ type: "shopify", storeUrl: "https://s.myshopify.com", accessToken: "tok" });
    const r = await adapter.publish({ title: "Hi", html: "<p>x</p>", slug: "hi" });
    expect(mockFetch.mock.calls[1][0]).toBe("https://s.myshopify.com/admin/api/2025-01/blogs/7/articles.json");
    expect(r.externalId).toBe("99");
  });

  it("says so when the store has no blog", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ blogs: [] }));
    const adapter = new ShopifyAdapter({ type: "shopify", storeUrl: "https://s.myshopify.com", accessToken: "tok" });
    await expect(adapter.publish({ title: "Hi", html: "", slug: "hi" })).rejects.toThrow("No blogs found on Shopify store");
  });
});
