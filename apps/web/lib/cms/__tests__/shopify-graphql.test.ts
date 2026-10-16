/**
 * The Shopify adapter over the GraphQL Admin API.
 *
 * fetch is a fake Shopify that answers by operation name (every query the
 * adapter sends is named AltoRank…), so a case states what the store says
 * rather than the order calls happen to be made in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const installedAccessToken = vi.fn();
vi.mock("@/lib/shopify/installations", () => ({ installedAccessToken }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));

import { ShopifyAdapter, shopifyCredential } from "../shopify";
import { SHOPIFY_API_VERSION } from "@/lib/shopify/env";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const STORE = "https://mystore.myshopify.com";
type Answer = { status?: number; body: unknown };
let answers: Record<string, Answer | Answer[]> = {};

function operation(init: RequestInit): string {
  const query = JSON.parse(String(init.body)).query as string;
  return /(?:query|mutation)\s+(AltoRank\w+)/.exec(query)?.[1] ?? "unknown";
}

beforeEach(() => {
  mockFetch.mockReset();
  installedAccessToken.mockReset();
  answers = {
    AltoRankShop: { body: { data: { shop: { name: "Fern & Co" } } } },
    AltoRankBlogs: { body: { data: { blogs: { nodes: [{ id: "gid://shopify/Blog/123", title: "News", handle: "news" }] } } } },
    AltoRankArticleCreate: {
      body: { data: { articleCreate: { article: { id: "gid://shopify/Article/99", handle: "hello" }, userErrors: [] } } },
    },
    AltoRankArticleUpdate: {
      body: { data: { articleUpdate: { article: { id: "gid://shopify/Article/99", handle: "hello" }, userErrors: [] } } },
    },
    AltoRankArticleDelete: { body: { data: { articleDelete: { deletedArticleId: "gid://shopify/Article/99", userErrors: [] } } } },
    AltoRankScopes: {
      body: { data: { currentAppInstallation: { accessScopes: [{ handle: "read_content" }, { handle: "write_content" }] } } },
    },
  };
  mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const name = operation(init);
    const queued = answers[name];
    const answer = Array.isArray(queued) ? (queued.length > 1 ? queued.shift()! : queued[0]) : queued;
    if (!answer) throw new Error(`unexpected operation ${name}`);
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  });
});

const sent = (name: string) =>
  mockFetch.mock.calls
    .filter(([, init]) => operation(init) === name)
    .map(([url, init]) => ({ url: String(url), headers: init.headers as Record<string, string>, variables: JSON.parse(String(init.body)).variables }));

const adapter = () =>
  new ShopifyAdapter({ type: "shopify", storeUrl: STORE, accessToken: "shpat_x", blogId: "123", blogHandle: "news" });

describe("publish", () => {
  it("creates the article in the chosen blog, signed with the store's name", async () => {
    const result = await adapter().publish({
      title: "Hello",
      html: "<p>world</p>",
      slug: "hello",
      tags: ["seo", "guides"],
      metaDescription: "A short summary",
    });

    const [create] = sent("AltoRankArticleCreate");
    expect(create.url).toBe(`${STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(create.headers["X-Shopify-Access-Token"]).toBe("shpat_x");
    expect(create.variables.article).toMatchObject({
      blogId: "gid://shopify/Blog/123",
      title: "Hello",
      body: "<p>world</p>",
      tags: ["seo", "guides"],
      author: { name: "Fern & Co" },
      isPublished: true,
      summary: "<p>A short summary</p>",
    });
    expect(typeof create.variables.article.publishDate).toBe("string");
    // Stored ids stay numeric, as they were under REST.
    expect(result).toEqual({ externalId: "99", url: `${STORE}/blogs/news/hello` });
  });

  it("a hidden (draft) article claims no storefront URL", async () => {
    const result = await adapter().publish({ title: "Hello", html: "<p>w</p>", slug: "hello", publishMode: "draft" });
    expect(sent("AltoRankArticleCreate")[0].variables.article.isPublished).toBe(false);
    expect(sent("AltoRankArticleCreate")[0].variables.article).not.toHaveProperty("publishDate");
    expect(result).toEqual({ externalId: "99", url: "" });
  });

  it("looks the blog up when none is chosen, and its handle when the connection predates it", async () => {
    const noBlog = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, accessToken: "shpat_x" });
    const result = await noBlog.publish({ title: "T", html: "<p>h</p>", slug: "t" });
    expect(sent("AltoRankArticleCreate")[0].variables.article.blogId).toBe("gid://shopify/Blog/123");
    expect(result.url).toBe(`${STORE}/blogs/news/hello`);
  });

  it("says so when the chosen blog is gone, instead of publishing elsewhere", async () => {
    const stale = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, accessToken: "shpat_x", blogId: "999" });
    await expect(stale.publish({ title: "T", html: "<p>h</p>", slug: "t" })).rejects.toThrow(/not on this store any more/);
    expect(sent("AltoRankArticleCreate")).toHaveLength(0);
  });

  it("throws Shopify's own userErrors", async () => {
    answers.AltoRankArticleCreate = {
      body: { data: { articleCreate: { article: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } },
    };
    await expect(adapter().publish({ title: "", html: "", slug: "x" })).rejects.toThrow(
      "Shopify publish failed: Title can't be blank",
    );
  });

  it("waits and retries when Shopify answers THROTTLED", async () => {
    vi.useFakeTimers();
    answers.AltoRankShop = [
      { body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
      { body: { data: { shop: { name: "Fern & Co" } } } },
    ];
    const pending = adapter().publish({ title: "T", html: "<p>h</p>", slug: "t" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ externalId: "99" });
    expect(sent("AltoRankShop")).toHaveLength(2);
    vi.useRealTimers();
  });

  it("reports an HTTP failure with its status", async () => {
    answers.AltoRankShop = { status: 404, body: "Not Found" };
    await expect(adapter().publish({ title: "T", html: "", slug: "t" })).rejects.toThrow(/Shopify 404/);
  });
});

describe("update and unpublish", () => {
  // P0-C7: without update(), the second press of Publish on a Shopify draft
  // hit core.ts's "cannot be updated in place" refusal.
  it("update() rewrites the article in place by its id and keeps it", async () => {
    const result = await adapter().update("99", { title: "New", html: "<p>w2</p>", slug: "hello" });
    const [update] = sent("AltoRankArticleUpdate");
    expect(update.variables.id).toBe("gid://shopify/Article/99");
    expect(update.variables.article).toMatchObject({ title: "New", body: "<p>w2</p>", isPublished: true });
    expect(result).toEqual({ externalId: "99", url: `${STORE}/blogs/news/hello` });
  });

  it("unpublish() deletes the article by its id", async () => {
    await adapter().unpublish("99");
    expect(sent("AltoRankArticleDelete")[0].variables.id).toBe("gid://shopify/Article/99");
  });
});

describe("testConnection", () => {
  it("passes when the blog list answers and write_content is granted", async () => {
    expect(await adapter().testConnection()).toEqual({ ok: true });
  });

  // P0-C4: a read-only app used to pass the test, save, and 403 on the first publish.
  it("refuses an app without write_content", async () => {
    answers.AltoRankScopes = { body: { data: { currentAppInstallation: { accessScopes: [{ handle: "read_content" }] } } } };
    const result = await adapter().testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/needs write_content/);
  });

  it("reports the HTTP status when the store refuses", async () => {
    answers.AltoRankBlogs = { status: 401, body: {} };
    expect(await adapter().testConnection()).toEqual({ ok: false, error: "HTTP 401" });
  });
});

describe("installed from the App Store", () => {
  const installed = () =>
    new ShopifyAdapter({ type: "shopify", storeUrl: STORE, installationId: "inst-1", blogId: "123", blogHandle: "news" });

  it("is its own credential kind and cannot be mixed with a pasted one", () => {
    expect(shopifyCredential({ installationId: "inst-1" })).toEqual({ kind: "installed", installationId: "inst-1" });
    expect(() => shopifyCredential({ installationId: "inst-1", accessToken: "t" })).toThrow(/no pasted credential/);
  });

  it("publishes with the installation's token", async () => {
    installedAccessToken.mockResolvedValue({ shop: "mystore.myshopify.com", token: "shpat_installed" });
    await installed().publish({ title: "T", html: "<p>h</p>", slug: "t" });
    expect(installedAccessToken).toHaveBeenCalledWith({}, "inst-1", { rejectToken: null });
    expect(sent("AltoRankArticleCreate")[0].headers["X-Shopify-Access-Token"]).toBe("shpat_installed");
  });

  it("refuses to send the token to a store other than the installation's", async () => {
    installedAccessToken.mockResolvedValue({ shop: "victim.myshopify.com", token: "shpat_victim" });
    await expect(installed().publish({ title: "T", html: "", slug: "t" })).rejects.toThrow(/different store/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("on a 401 asks for a token other than the one that failed, and retries once", async () => {
    installedAccessToken
      .mockResolvedValueOnce({ shop: "mystore.myshopify.com", token: "tok_old" })
      .mockResolvedValueOnce({ shop: "mystore.myshopify.com", token: "tok_new" })
      .mockResolvedValue({ shop: "mystore.myshopify.com", token: "tok_new" });
    answers.AltoRankShop = [{ status: 401, body: {} }, { body: { data: { shop: { name: "Fern & Co" } } } }];

    await installed().publish({ title: "T", html: "<p>h</p>", slug: "t" });
    expect(installedAccessToken.mock.calls[1][2]).toEqual({ rejectToken: "tok_old" });
    expect(sent("AltoRankShop").map((c) => c.headers["X-Shopify-Access-Token"])).toEqual(["tok_old", "tok_new"]);
  });
});
