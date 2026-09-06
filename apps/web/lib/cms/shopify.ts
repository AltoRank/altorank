import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { ShopifyConfig, ShopifyCredentials } from "@/lib/types";

const SHOPIFY_API_VERSION = "2025-01";

/**
 * Every call this adapter makes is to /blogs.json and /blogs/{id}/articles.json,
 * which Shopify files under the `content` scope pair. Nothing else is asked
 * for, and the connect dialog reads this list rather than restating it.
 * https://shopify.dev/docs/api/usage/access-scopes
 */
export const SHOPIFY_REQUIRED_SCOPES = ["read_content", "write_content"] as const;

export interface ShopifyBlog {
  id: string;
  title: string;
  handle: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** The two ways into a store, told apart once and carried as a tagged value. */
export type ShopifyCredential =
  | { kind: "token"; accessToken: string }
  | { kind: "client"; clientId: string; clientSecret: string };

/**
 * The one place that decides which credential a config holds.
 *
 * A legacy custom app gives a token; a Dev Dashboard app gives a client id
 * and secret. A config with both was assembled wrong somewhere upstream and
 * one with neither cannot authenticate, so both are refused here rather than
 * left for Shopify to answer with a 401 nobody can act on. The zod schema in
 * app/actions/integrations.ts and the adapter both call this, so the rule
 * lives once. Stored rows and typed forms both arrive here, hence the loose
 * input shape.
 */
export function shopifyCredential(input: {
  accessToken?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
}): ShopifyCredential {
  const accessToken = input.accessToken?.trim() || "";
  const clientId = input.clientId?.trim() || "";
  const clientSecret = input.clientSecret?.trim() || "";
  const hasToken = accessToken.length > 0;
  const hasClient = clientId.length > 0 || clientSecret.length > 0;

  if (hasToken && hasClient) {
    throw new Error("Give either an Admin API access token or a Client ID and secret, not both.");
  }
  if (hasToken) return { kind: "token", accessToken };
  if (clientId && clientSecret) return { kind: "client", clientId, clientSecret };
  if (hasClient) throw new Error("A Client ID and a Client secret are both required.");
  throw new Error("An Admin API access token, or a Client ID and secret, is required.");
}

/** The config-shaped view of a credential, for callers that take `ShopifyCredentials`. */
export function shopifyCredentialsOf(credential: ShopifyCredential): ShopifyCredentials {
  return credential.kind === "token"
    ? { accessToken: credential.accessToken }
    : { clientId: credential.clientId, clientSecret: credential.clientSecret };
}

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

/**
 * Tokens from the client-credentials grant, cached per (store, client id).
 *
 * Shopify's doc for the grant:
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 *
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&client_id=...&client_secret=...
 *
 *   → { "access_token": "...", "scope": "read_content,write_content", "expires_in": 86399 }
 *
 * The doc: "Tokens expire after 24 hours, so the example caches the token and
 * refreshes it before expiry rather than requesting a new one per call." We
 * do the same, refreshing REFRESH_MARGIN_MS before `expires_in` runs out and
 * on any 401, and never more than once per request for a 401 (a second 401
 * with a fresh token is a scope or install problem, not a stale token).
 *
 * The cache is process memory, keyed so two stores or two apps on one store
 * never share a token. Neither the secret nor the token is ever logged; the
 * only thing that leaves this module is the token, inside a request header.
 * Concurrent callers waiting on the same exchange share one in-flight
 * request rather than each asking Shopify.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();

/** Tests only: the cache is module state and would otherwise leak between cases. */
export function clearShopifyTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}

function cacheKey(storeUrl: string, clientId: string): string {
  return `${new URL(storeUrl).host}|${clientId}`;
}

async function exchangeClientCredentials(
  storeUrl: string,
  credential: Extract<ShopifyCredential, { kind: "client" }>,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credential.clientId,
    client_secret: credential.clientSecret,
  });
  const res = await fetch(`${storeUrl}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Shopify's error body names the failure (e.g. `shop_not_permitted` when
    // app and store are in different organisations) and never echoes the
    // secret; ours must not either, so the request is not described here.
    const err = await res.text();
    throw new Error(`Shopify token exchange failed (${res.status})${err ? `: ${err}` : ""}`);
  }
  const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Shopify token exchange returned no access token");
  }
  // The doc says expires_in is 86399; trust the value, and fall back to a
  // short life if a response ever omits it rather than caching forever.
  const ttlSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 600;
  return { token: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

/**
 * The token to send right now. A legacy token is returned as is; a client
 * credential is exchanged, or served from cache while it is more than
 * REFRESH_MARGIN_MS from expiry. `forceRefresh` drops the cached token first,
 * for the 401 path.
 */
async function resolveToken(storeUrl: string, credential: ShopifyCredential, forceRefresh = false): Promise<string> {
  if (credential.kind === "token") return credential.accessToken;

  const key = cacheKey(storeUrl, credential.clientId);
  if (forceRefresh) tokenCache.delete(key);

  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;

  let pending = inflight.get(key);
  if (!pending) {
    pending = exchangeClientCredentials(storeUrl, credential)
      .then((fresh) => {
        tokenCache.set(key, fresh);
        return fresh;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return (await pending).token;
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

/**
 * Every Admin API call goes through here: the token header is added, and a
 * 401 on a client-credentials connection refreshes the token and retries the
 * request once. Legacy tokens are not retried - a 401 there means the token
 * was revoked, and the caller gets the status to show.
 */
async function shopifyRequest(
  storeUrl: string,
  credential: ShopifyCredential,
  path: string,
  init: Omit<RequestInit, "headers"> = {},
): Promise<Response> {
  const url = `${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const send = async (token: string) =>
    fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
    });

  let res = await send(await resolveToken(storeUrl, credential));
  if (res.status === 401 && credential.kind === "client") {
    res = await send(await resolveToken(storeUrl, credential, true));
  }
  return res;
}

function normaliseStoreUrl(storeUrl: string): string {
  return storeUrl.replace(/\/+$/, "");
}

/**
 * The store's blogs. Shared by the adapter (to default to the first one) and
 * the connect dialog (to let the person pick), so both see the same list.
 */
export async function listShopifyBlogs(storeUrl: string, credentials: ShopifyCredentials): Promise<ShopifyBlog[]> {
  const base = normaliseStoreUrl(storeUrl);
  const res = await shopifyRequest(base, shopifyCredential(credentials), "blogs.json");
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify ${res.status}${err ? `: ${err}` : ""}`);
  }
  const data = (await res.json()) as {
    blogs?: Array<{ id: number | string; title?: string; handle?: string }>;
  };
  return (data.blogs ?? []).map((b) => ({
    id: String(b.id),
    title: b.title ?? b.handle ?? String(b.id),
    handle: b.handle ?? "",
  }));
}

/**
 * A storefront article URL.
 *
 * Shopify's storefront routes an article as `/blogs/{blog-handle}/{article-handle}`.
 * The adapter used to build `/blogs/{blogId}/{handle}` from the numeric blog
 * id, which is an admin identifier and not part of any storefront path, so
 * every "View published article" on a Shopify connection was a 404 - and it
 * went to IndexNow under the store's own domain. The handle is read off the
 * store's blog list, which the connect dialog already shows.
 * https://shopify.dev/docs/api/admin-rest/latest/resources/article
 */
export function shopifyArticleUrl(
  storeUrl: string,
  blogHandle: string,
  articleHandle: string,
): string {
  if (!blogHandle || !articleHandle) return "";
  return `${normaliseStoreUrl(storeUrl)}/blogs/${blogHandle}/${articleHandle}`;
}

/** The scopes Shopify says this app was granted, or null when it will not say. */
export async function shopifyGrantedScopes(
  storeUrl: string,
  credentials: ShopifyCredentials,
): Promise<string[] | null> {
  try {
    // Not a versioned endpoint, so it does not go through shopifyRequest.
    const token = await resolveToken(normaliseStoreUrl(storeUrl), shopifyCredential(credentials));
    const res = await fetch(`${normaliseStoreUrl(storeUrl)}/admin/oauth/access_scopes.json`, {
      headers: { "X-Shopify-Access-Token": token },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_scopes?: Array<{ handle?: string }> };
    const scopes = (data.access_scopes ?? [])
      .map((s) => s.handle)
      .filter((h): h is string => typeof h === "string");
    return scopes.length ? scopes : null;
  } catch {
    return null;
  }
}

export class ShopifyAdapter implements CMSAdapter {
  private storeUrl: string;
  private credential: ShopifyCredential;
  private blogId: string | undefined;
  private blogHandle: string | undefined;

  constructor(config: ShopifyConfig) {
    this.storeUrl = normaliseStoreUrl(config.storeUrl);
    this.credential = shopifyCredential(config);
    this.blogId = config.blogId;
    this.blogHandle = config.blogHandle;
  }

  private request(path: string, init?: Omit<RequestInit, "headers">) {
    return shopifyRequest(this.storeUrl, this.credential, path, init);
  }

  /**
   * The blog to publish into, id and handle.
   *
   * The handle is what a storefront URL is made of, so it is resolved
   * alongside the id: from the connection when the dialog stored it, and off
   * the store's own blog list otherwise, which is also how a connection with
   * no blog chosen finds the first one.
   */
  private async resolveBlog(): Promise<{ id: string; handle: string }> {
    if (this.blogId && this.blogHandle) return { id: this.blogId, handle: this.blogHandle };

    const blogs = await listShopifyBlogs(this.storeUrl, shopifyCredentialsOf(this.credential));
    if (!blogs.length) throw new Error("No blogs found on Shopify store");

    const chosen = this.blogId ? blogs.find((b) => b.id === this.blogId) : blogs[0];
    if (!chosen) {
      throw new Error(`Blog ${this.blogId} is not on this store any more. Reconnect and choose one.`);
    }
    this.blogId = chosen.id;
    this.blogHandle = chosen.handle;
    return { id: chosen.id, handle: chosen.handle };
  }

  private async resolveBlogId(): Promise<string> {
    return (await this.resolveBlog()).id;
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const { id: blogId, handle: blogHandle } = await this.resolveBlog();
    const draft = article.publishMode === "draft";

    const res = await this.request(`blogs/${blogId}/articles.json`, {
      method: "POST",
      body: JSON.stringify({
        article: {
          title: article.title,
          body_html: article.html,
          tags: article.tags?.join(", ") ?? "",
          // An unpublished article is Shopify's draft: it exists in the admin
          // and is hidden from the storefront until someone sets it visible.
          published: !draft,
          ...(draft ? {} : { published_at: article.publishedAt ?? new Date().toISOString() }),
          summary_html: article.metaDescription ? `<p>${article.metaDescription}</p>` : undefined,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Shopify publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.article.id),
      // A hidden article has no storefront URL to claim.
      url: draft
        ? ""
        : data.article.url ?? shopifyArticleUrl(this.storeUrl, blogHandle, data.article.handle),
    };
  }

  /**
   * Rewrite the article in place.
   *
   * Without this, a Shopify connection - which defaults to draft mode - hit
   * lib/publishing/core.ts's "cannot be updated in place from here" refusal on
   * the second press of Publish, with nothing else on offer. The Admin REST
   * article resource has a PUT, so the refusal was ours, not Shopify's.
   */
  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const { id: blogId, handle: blogHandle } = await this.resolveBlog();
    const draft = article.publishMode === "draft";

    const res = await this.request(`blogs/${blogId}/articles/${externalId}.json`, {
      method: "PUT",
      body: JSON.stringify({
        article: {
          id: Number(externalId),
          title: article.title,
          body_html: article.html,
          tags: article.tags?.join(", ") ?? "",
          published: !draft,
          summary_html: article.metaDescription ? `<p>${article.metaDescription}</p>` : undefined,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Shopify update failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.article?.id ?? externalId),
      url: draft
        ? ""
        : data.article?.url ?? shopifyArticleUrl(this.storeUrl, blogHandle, data.article?.handle ?? article.slug),
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const blogId = await this.resolveBlogId();

    const res = await this.request(`blogs/${blogId}/articles/${externalId}.json`, { method: "DELETE" });

    if (!res.ok) throw new Error(`Shopify unpublish failed (${res.status})`);
  }

  /**
   * The store answers, and the app may write.
   *
   * The read alone used to be the whole test, so a `read_content`-only app
   * passed, saved, and 403'd on the first publish - which the dialog had
   * already called a passed connection test. Shopify will name the granted
   * scopes, so when it does, a missing write_content is a refusal here
   * instead of a failed publish later. When it will not say, the read result
   * stands and the dialog says only that the store answered a read request.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.request("blogs.json");
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

      const scopes = await shopifyGrantedScopes(this.storeUrl, shopifyCredentialsOf(this.credential));
      if (scopes && !scopes.includes("write_content")) {
        return {
          ok: false,
          error: `This app was granted ${scopes.join(", ")}. Publishing needs write_content: add it to the app's scopes and reinstall.`,
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
