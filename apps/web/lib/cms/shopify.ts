import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { ShopifyConfig, ShopifyCredentials } from "@/lib/types";
import { SHOPIFY_API_VERSION } from "@/lib/shopify/env";

import type { ShopifyBlog } from "./shopify-scopes";

export { SHOPIFY_REQUIRED_SCOPES, type ShopifyBlog } from "./shopify-scopes";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** The three ways into a store, told apart once and carried as a tagged value. */
export type ShopifyCredential =
  | { kind: "token"; accessToken: string }
  | { kind: "client"; clientId: string; clientSecret: string }
  | { kind: "installed"; installationId: string };

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
  installationId?: string | null;
}): ShopifyCredential {
  const accessToken = input.accessToken?.trim() || "";
  const clientId = input.clientId?.trim() || "";
  const clientSecret = input.clientSecret?.trim() || "";
  const installationId = input.installationId?.trim() || "";
  const hasToken = accessToken.length > 0;
  const hasClient = clientId.length > 0 || clientSecret.length > 0;

  if (installationId) {
    if (hasToken || hasClient) throw new Error("An installed app connection carries no pasted credential.");
    return { kind: "installed", installationId };
  }
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
  switch (credential.kind) {
    case "token":
      return { accessToken: credential.accessToken };
    case "client":
      return { clientId: credential.clientId, clientSecret: credential.clientSecret };
    case "installed":
      return { installationId: credential.installationId };
  }
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
 * The cache is process memory, keyed by store, app and a digest of the secret,
 * so two stores or two apps on one store never share a token, and a caller
 * without the secret never receives one. Neither the secret nor the token is ever logged; the
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

/**
 * Store, app and a digest of the secret. The secret is part of the key so a
 * cached token is only ever handed to a caller holding the credential that
 * earned it: the client id is public, and a key of store + client id alone
 * served the token to anyone who could name them.
 */
async function cacheKey(storeUrl: string, credential: Extract<ShopifyCredential, { kind: "client" }>): Promise<string> {
  // Web Crypto rather than node:crypto: the connect form imports this module
  // for its credential check, and a Node builtin cannot reach a client bundle.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential.clientSecret));
  const secret = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${new URL(storeUrl).host}|${credential.clientId}|${secret}`;
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
 * An App Store installation's token, from shopify_installations.
 *
 * The store is checked against the connection's own storeUrl: the pointer in
 * config is only trusted to name a row, not to decide which store a token is
 * sent to. Loaded lazily so the rest of this module (and its tests) never
 * pulls in the server-side Supabase client.
 */
async function installedToken(storeUrl: string, installationId: string, rejectToken: string | null): Promise<string> {
  const [{ createServiceClient }, { installedAccessToken }] = await Promise.all([
    import("@/lib/supabase/server"),
    import("@/lib/shopify/installations"),
  ]);
  const { shop, token } = await installedAccessToken(createServiceClient(), installationId, { rejectToken });
  if (new URL(storeUrl).host !== shop) throw new Error("This Shopify connection points at a different store than its installation.");
  return token;
}

/**
 * The token to send right now. A legacy token is returned as is; a client
 * credential is exchanged, or served from cache while it is more than
 * REFRESH_MARGIN_MS from expiry. `forceRefresh` drops the cached token first,
 * for the 401 path.
 */
async function resolveToken(
  storeUrl: string,
  credential: ShopifyCredential,
  forceRefresh = false,
  rejectToken: string | null = null,
): Promise<string> {
  if (credential.kind === "token") return credential.accessToken;
  if (credential.kind === "installed") return installedToken(storeUrl, credential.installationId, rejectToken);

  const key = await cacheKey(storeUrl, credential);
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
// GraphQL helper
// ---------------------------------------------------------------------------

/** Shopify answered, and said no. `status` is the HTTP status (200 for a GraphQL-level refusal). */
export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

const THROTTLE_RETRIES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every Admin API call goes through here, as GraphQL: public apps may only
 * use the GraphQL Admin API, and one client for every connection kind keeps
 * the two paths from drifting.
 * https://shopify.dev/docs/api/admin-graphql
 *
 * - A 401 on a credential that can be renewed (client grant, installed app)
 *   gets one fresh token and one retry. A legacy token is not retried: a 401
 *   there means it was revoked.
 * - GraphQL reports most failures as HTTP 200 with `errors[]`. THROTTLED is
 *   the cost-based rate limit and is retried after the second Shopify
 *   recommends; anything else is thrown with Shopify's own words.
 *   https://shopify.dev/docs/api/usage/rate-limits
 * - `userErrors` belong to a mutation's payload and are the caller's to read.
 */
async function shopifyGraphql<T>(
  storeUrl: string,
  credential: ShopifyCredential,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const url = `${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const send = (token: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });

  for (let attempt = 0; ; attempt++) {
    let token = await resolveToken(storeUrl, credential);
    let res = await send(token);
    if (res.status === 401 && credential.kind !== "token") {
      token = await resolveToken(storeUrl, credential, true, token);
      res = await send(token);
    }
    if (!res.ok) {
      const err = await res.text();
      throw new ShopifyApiError(`Shopify ${res.status}${err ? `: ${err}` : ""}`, res.status);
    }

    const body = (await res.json()) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < THROTTLE_RETRIES) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ShopifyApiError(`Shopify: ${body.errors.map((e) => e.message ?? "error").join("; ")}`, res.status);
    }
    if (!body.data) throw new ShopifyApiError("Shopify returned no data", res.status);
    return body.data;
  }
}

/**
 * A one-off Admin API query outside the adapter, through the same client:
 * the embedded app reads the shop's name, email and domains with it when a
 * store is first set up. Credentials go through `shopifyCredential`, so the
 * installed-app store check applies here too.
 */
export function queryShopify<T>(
  storeUrl: string,
  credentials: ShopifyCredentials,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return shopifyGraphql<T>(normaliseStoreUrl(storeUrl), shopifyCredential(credentials), query, variables);
}

interface UserError {
  field?: string[] | null;
  message: string;
}

function throwUserErrors(what: string, errors: UserError[] | null | undefined): void {
  if (!errors?.length) return;
  throw new ShopifyApiError(`Shopify ${what} failed: ${errors.map((e) => e.message).join("; ")}`, 200);
}

/** `gid://shopify/Blog/7` ↔ `7`. Stored ids stay numeric, as they were under REST. */
function toGid(type: "Blog" | "Article", id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/${type}/${id}`;
}
function fromGid(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function normaliseStoreUrl(storeUrl: string): string {
  return storeUrl.replace(/\/+$/, "");
}

const BLOGS_QUERY = `query AltoRankBlogs { blogs(first: 50) { nodes { id title handle } } }`;

/**
 * The store's blogs. Shared by the adapter (to default to the first one) and
 * the connect dialog (to let the person pick), so both see the same list.
 */
export async function listShopifyBlogs(storeUrl: string, credentials: ShopifyCredentials): Promise<ShopifyBlog[]> {
  const base = normaliseStoreUrl(storeUrl);
  const data = await shopifyGraphql<{ blogs: { nodes: Array<{ id: string; title?: string; handle?: string }> } }>(
    base,
    shopifyCredential(credentials),
    BLOGS_QUERY,
  );
  return (data.blogs?.nodes ?? []).map((b) => ({
    id: fromGid(b.id),
    title: b.title ?? b.handle ?? fromGid(b.id),
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
    const data = await shopifyGraphql<{ currentAppInstallation: { accessScopes: Array<{ handle?: string }> } }>(
      normaliseStoreUrl(storeUrl),
      shopifyCredential(credentials),
      `query AltoRankScopes { currentAppInstallation { accessScopes { handle } } }`,
    );
    const scopes = (data.currentAppInstallation?.accessScopes ?? [])
      .map((s) => s.handle)
      .filter((h): h is string => typeof h === "string");
    return scopes.length ? scopes : null;
  } catch {
    return null;
  }
}

const ARTICLE_CREATE = `mutation AltoRankArticleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) { article { id handle } userErrors { field message } }
}`;
const ARTICLE_UPDATE = `mutation AltoRankArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) { article { id handle } userErrors { field message } }
}`;
const ARTICLE_DELETE = `mutation AltoRankArticleDelete($id: ID!) {
  articleDelete(id: $id) { deletedArticleId userErrors { field message } }
}`;

export class ShopifyAdapter implements CMSAdapter {
  private storeUrl: string;
  private credential: ShopifyCredential;
  private blogId: string | undefined;
  private blogHandle: string | undefined;
  private shopName: string | undefined;

  constructor(config: ShopifyConfig) {
    this.storeUrl = normaliseStoreUrl(config.storeUrl);
    this.credential = shopifyCredential(config);
    this.blogId = config.blogId;
    this.blogHandle = config.blogHandle;
  }

  private graphql<T>(query: string, variables?: Record<string, unknown>) {
    return shopifyGraphql<T>(this.storeUrl, this.credential, query, variables);
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

  /**
   * The byline. GraphQL's articleCreate requires an author where REST filled
   * one in, and the store's own name is what a merchant would expect on a
   * post they did not sign - never "AltoRank".
   */
  private async authorName(): Promise<string> {
    if (this.shopName) return this.shopName;
    const data = await this.graphql<{ shop: { name?: string } }>(`query AltoRankShop { shop { name } }`);
    this.shopName = data.shop?.name?.trim() || new URL(this.storeUrl).host;
    return this.shopName;
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const { id: blogId, handle: blogHandle } = await this.resolveBlog();
    const draft = article.publishMode === "draft";

    const data = await this.graphql<{
      articleCreate: { article: { id: string; handle: string } | null; userErrors: UserError[] };
    }>(ARTICLE_CREATE, {
      article: {
        blogId: toGid("Blog", blogId),
        title: article.title,
        body: article.html,
        tags: article.tags ?? [],
        author: { name: await this.authorName() },
        // An unpublished article is Shopify's draft: it exists in the admin
        // and is hidden from the storefront until someone sets it visible.
        isPublished: !draft,
        ...(draft ? {} : { publishDate: article.publishedAt ?? new Date().toISOString() }),
        ...(article.metaDescription ? { summary: `<p>${article.metaDescription}</p>` } : {}),
      },
    });
    throwUserErrors("publish", data.articleCreate?.userErrors);
    const created = data.articleCreate?.article;
    if (!created) throw new ShopifyApiError("Shopify publish failed: no article returned", 200);

    return {
      externalId: fromGid(created.id),
      // A hidden article has no storefront URL to claim.
      url: draft ? "" : shopifyArticleUrl(this.storeUrl, blogHandle, created.handle),
    };
  }

  /**
   * Rewrite the article in place.
   *
   * Without this, a Shopify connection - which defaults to draft mode - hit
   * lib/publishing/core.ts's "cannot be updated in place from here" refusal on
   * the second press of Publish, with nothing else on offer.
   */
  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const { handle: blogHandle } = await this.resolveBlog();
    const draft = article.publishMode === "draft";

    const data = await this.graphql<{
      articleUpdate: { article: { id: string; handle: string } | null; userErrors: UserError[] };
    }>(ARTICLE_UPDATE, {
      id: toGid("Article", externalId),
      article: {
        title: article.title,
        body: article.html,
        tags: article.tags ?? [],
        isPublished: !draft,
        ...(article.metaDescription ? { summary: `<p>${article.metaDescription}</p>` } : {}),
      },
    });
    throwUserErrors("update", data.articleUpdate?.userErrors);
    const updated = data.articleUpdate?.article;

    return {
      externalId: updated ? fromGid(updated.id) : externalId,
      url: draft ? "" : shopifyArticleUrl(this.storeUrl, blogHandle, updated?.handle ?? article.slug),
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const data = await this.graphql<{ articleDelete: { userErrors: UserError[] } }>(ARTICLE_DELETE, {
      id: toGid("Article", externalId),
    });
    throwUserErrors("unpublish", data.articleDelete?.userErrors);
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
      await this.graphql(BLOGS_QUERY);

      const scopes = await shopifyGrantedScopes(this.storeUrl, shopifyCredentialsOf(this.credential));
      if (scopes && !scopes.includes("write_content") && !scopes.includes("write_online_store_pages")) {
        return {
          ok: false,
          error: `This app was granted ${scopes.join(", ")}. Publishing needs write_content: add it to the app's scopes and reinstall.`,
        };
      }
      return { ok: true };
    } catch (e) {
      const err = e as Error;
      if (err instanceof ShopifyApiError && err.status !== 200) return { ok: false, error: `HTTP ${err.status}` };
      return { ok: false, error: err.message };
    }
  }
}
