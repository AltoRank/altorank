/**
 * The Shopify client-credentials grant, as the connector performs it.
 *
 * Shopify's doc:
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 * POST {shop}/admin/oauth/access_token, form-encoded grant_type=client_credentials
 * + client_id + client_secret → { access_token, scope, expires_in: 86399 }.
 *
 * fetch is mocked throughout; no store is called. Timers are faked so expiry
 * can be walked through without waiting a day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShopifyAdapter, clearShopifyTokenCache, listShopifyBlogs, shopifyCredential } from "../shopify";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const STORE = "https://s.myshopify.com";
const CLIENT = { clientId: "cid_1", clientSecret: "shpss_secret" };

const okJson = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const tokenResponse = (token: string, expiresIn = 86399) => okJson({ access_token: token, scope: "read_content,write_content", expires_in: expiresIn });
const blogsResponse = okJson({ blogs: [{ id: 7, title: "News", handle: "news" }] });

/** The calls fetch has seen, as [url, method, headers, body]. */
function calls() {
  return mockFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init?.method as string | undefined) ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body as unknown,
  }));
}

beforeEach(() => {
  mockFetch.mockReset();
  clearShopifyTokenCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("shopifyCredential", () => {
  it("accepts a legacy token", () => {
    expect(shopifyCredential({ accessToken: "shpat_x" })).toEqual({ kind: "token", accessToken: "shpat_x" });
  });

  it("accepts a client id + secret", () => {
    expect(shopifyCredential(CLIENT)).toEqual({ kind: "client", ...CLIENT });
  });

  it("treats blank strings as absent, so a form's empty field is not a second credential", () => {
    expect(shopifyCredential({ accessToken: "", ...CLIENT })).toEqual({ kind: "client", ...CLIENT });
    expect(shopifyCredential({ accessToken: "tok", clientId: "", clientSecret: " " })).toEqual({ kind: "token", accessToken: "tok" });
  });

  it("rejects both credentials at once", () => {
    expect(() => shopifyCredential({ accessToken: "tok", ...CLIENT })).toThrow(/not both/);
  });

  it("rejects neither", () => {
    expect(() => shopifyCredential({})).toThrow(/required/);
    expect(() => shopifyCredential({ accessToken: "  " })).toThrow(/required/);
  });

  it("rejects half a client credential", () => {
    expect(() => shopifyCredential({ clientId: "cid" })).toThrow(/both required/);
    expect(() => shopifyCredential({ clientSecret: "s" })).toThrow(/both required/);
  });

  it("the adapter refuses a config it cannot authenticate with", () => {
    expect(() => new ShopifyAdapter({ type: "shopify", storeUrl: STORE } as never)).toThrow(/required/);
    expect(
      () => new ShopifyAdapter({ type: "shopify", storeUrl: STORE, accessToken: "t", ...CLIENT } as never),
    ).toThrow(/not both/);
  });
});

// ---------------------------------------------------------------------------
// Exchange request shape
// ---------------------------------------------------------------------------

describe("client-credentials exchange", () => {
  it("posts the form-encoded grant to /admin/oauth/access_token and uses the token it gets", async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse("tok_A")).mockResolvedValueOnce(blogsResponse);

    const blogs = await listShopifyBlogs(`${STORE}/`, CLIENT);

    const [exchange, api] = calls();
    expect(exchange.url).toBe(`${STORE}/admin/oauth/access_token`);
    expect(exchange.method).toBe("POST");
    expect(exchange.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(exchange.body).toBeInstanceOf(URLSearchParams);
    const params = exchange.body as URLSearchParams;
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe(CLIENT.clientId);
    expect(params.get("client_secret")).toBe(CLIENT.clientSecret);
    // The exchange itself carries no access-token header.
    expect(exchange.headers["X-Shopify-Access-Token"]).toBeUndefined();

    expect(api.url).toBe(`${STORE}/admin/api/2025-01/blogs.json`);
    expect(api.headers["X-Shopify-Access-Token"]).toBe("tok_A");
    expect(blogs).toEqual([{ id: "7", title: "News", handle: "news" }]);
  });

  it("surfaces Shopify's exchange error without the secret in it", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ error: "shop_not_permitted" }, 400));
    await expect(listShopifyBlogs(STORE, CLIENT)).rejects.toThrow(/token exchange failed \(400\).*shop_not_permitted/);
    await expect(listShopifyBlogs(STORE, CLIENT)).rejects.not.toThrow(CLIENT.clientSecret);
  });

  it("refuses a 200 with no access_token rather than sending an empty header", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ scope: "read_content" }));
    await expect(listShopifyBlogs(STORE, CLIENT)).rejects.toThrow(/no access token/);
  });
});

// ---------------------------------------------------------------------------
// Caching and refresh
// ---------------------------------------------------------------------------

describe("token cache", () => {
  it("exchanges once and reuses the token across requests and adapter instances", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse("tok_A"))
      .mockResolvedValueOnce(blogsResponse)
      .mockResolvedValueOnce(blogsResponse)
      .mockResolvedValueOnce(blogsResponse);

    const a = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, ...CLIENT });
    const b = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, ...CLIENT });
    expect((await a.testConnection()).ok).toBe(true);
    expect((await a.testConnection()).ok).toBe(true);
    expect((await b.testConnection()).ok).toBe(true);

    const exchanges = calls().filter((c) => c.url.endsWith("/admin/oauth/access_token"));
    expect(exchanges).toHaveLength(1);
    for (const c of calls().filter((c) => c.url.includes("/admin/api/"))) {
      expect(c.headers["X-Shopify-Access-Token"]).toBe("tok_A");
    }
  });

  it("keys the cache per store and client id", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse("tok_store1"))
      .mockResolvedValueOnce(blogsResponse)
      .mockResolvedValueOnce(tokenResponse("tok_store2"))
      .mockResolvedValueOnce(blogsResponse)
      .mockResolvedValueOnce(tokenResponse("tok_app2"))
      .mockResolvedValueOnce(blogsResponse);

    await listShopifyBlogs("https://one.myshopify.com", CLIENT);
    await listShopifyBlogs("https://two.myshopify.com", CLIENT);
    await listShopifyBlogs("https://one.myshopify.com", { clientId: "cid_2", clientSecret: "other" });

    const api = calls().filter((c) => c.url.includes("/admin/api/"));
    expect(api.map((c) => c.headers["X-Shopify-Access-Token"])).toEqual(["tok_store1", "tok_store2", "tok_app2"]);
  });

  it("refreshes when within 5 minutes of expiry, not before", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse("tok_A", 86399))
      .mockResolvedValueOnce(blogsResponse)
      .mockResolvedValueOnce(blogsResponse)
      .mockResolvedValueOnce(tokenResponse("tok_B"))
      .mockResolvedValueOnce(blogsResponse);

    await listShopifyBlogs(STORE, CLIENT);

    // 23h 54m in: still more than five minutes left, served from cache.
    vi.advanceTimersByTime((86399 - 6 * 60) * 1000);
    await listShopifyBlogs(STORE, CLIENT);

    // Two minutes later: inside the margin, exchanged again before use.
    vi.advanceTimersByTime(2 * 60 * 1000);
    await listShopifyBlogs(STORE, CLIENT);

    const api = calls().filter((c) => c.url.includes("/admin/api/"));
    expect(api.map((c) => c.headers["X-Shopify-Access-Token"])).toEqual(["tok_A", "tok_A", "tok_B"]);
    expect(calls().filter((c) => c.url.endsWith("/admin/oauth/access_token"))).toHaveLength(2);
  });

  it("shares one in-flight exchange between concurrent callers", async () => {
    let resolveExchange: (v: unknown) => void = () => {};
    mockFetch
      .mockImplementationOnce(() => new Promise((r) => (resolveExchange = r)))
      .mockResolvedValue(blogsResponse);

    const p1 = listShopifyBlogs(STORE, CLIENT);
    const p2 = listShopifyBlogs(STORE, CLIENT);
    await Promise.resolve();
    resolveExchange(tokenResponse("tok_A"));
    await Promise.all([p1, p2]);

    expect(calls().filter((c) => c.url.endsWith("/admin/oauth/access_token"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 401 → refresh → retry once
// ---------------------------------------------------------------------------

describe("401 handling", () => {
  it("refreshes the token and retries the request once", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse("tok_stale"))
      .mockResolvedValueOnce(okJson({ errors: "[API] Invalid API key or access token" }, 401))
      .mockResolvedValueOnce(tokenResponse("tok_fresh"))
      .mockResolvedValueOnce(okJson({ article: { id: 99, handle: "hi" } }));

    const adapter = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, blogId: "7", ...CLIENT });
    const r = await adapter.publish({ title: "Hi", html: "<p>x</p>", slug: "hi" });

    expect(r.externalId).toBe("99");
    const seq = calls();
    expect(seq.map((c) => c.url.split("/").slice(-1)[0])).toEqual([
      "access_token",
      "articles.json",
      "access_token",
      "articles.json",
    ]);
    expect(seq[1].headers["X-Shopify-Access-Token"]).toBe("tok_stale");
    expect(seq[3].headers["X-Shopify-Access-Token"]).toBe("tok_fresh");
    // The retried request is the same request: method and body unchanged.
    expect(seq[3].method).toBe("POST");
    expect(seq[3].body).toBe(seq[1].body);
  });

  it("gives up after one retry and returns the second 401", async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse("tok_A"))
      .mockResolvedValueOnce(okJson({}, 401))
      .mockResolvedValueOnce(tokenResponse("tok_B"))
      .mockResolvedValueOnce(okJson({}, 401));

    const adapter = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, ...CLIENT });
    expect(await adapter.testConnection()).toEqual({ ok: false, error: "HTTP 401" });
    expect(calls()).toHaveLength(4);
  });

  it("does not retry a legacy token: a revoked token cannot be refreshed", async () => {
    mockFetch.mockResolvedValueOnce(okJson({}, 401));
    const adapter = new ShopifyAdapter({ type: "shopify", storeUrl: STORE, accessToken: "shpat_revoked" });
    expect(await adapter.testConnection()).toEqual({ ok: false, error: "HTTP 401" });
    expect(calls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Legacy token path unchanged
// ---------------------------------------------------------------------------

describe("legacy access token", () => {
  it("never calls the token endpoint and sends the token as given", async () => {
    mockFetch.mockResolvedValueOnce(blogsResponse).mockResolvedValueOnce(okJson({ article: { id: 1, handle: "a" } }));

    const adapter = new ShopifyAdapter({ type: "shopify", storeUrl: `${STORE}/`, accessToken: "shpat_legacy" });
    await adapter.publish({ title: "A", html: "", slug: "a" });

    const seq = calls();
    expect(seq.some((c) => c.url.endsWith("/admin/oauth/access_token"))).toBe(false);
    expect(seq.map((c) => c.url)).toEqual([
      `${STORE}/admin/api/2025-01/blogs.json`,
      `${STORE}/admin/api/2025-01/blogs/7/articles.json`,
    ]);
    for (const c of seq) expect(c.headers["X-Shopify-Access-Token"]).toBe("shpat_legacy");
  });
});
