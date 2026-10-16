import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  exchangeIdToken,
  parseTokenResponse,
  refreshAccessToken,
  ShopifyInvalidIdTokenError,
  ShopifyRefreshRevokedError,
} from "../tokens";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const APP = { clientId: "cid", clientSecret: "shpss_secret" };
const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const pair = { access_token: "shpat_a", expires_in: 3600, refresh_token: "shprt_r", refresh_token_expires_in: 7776000, scope: "read_content,write_content" };

beforeEach(() => mockFetch.mockReset());

describe("parseTokenResponse", () => {
  it("reads the lifetimes Shopify states", () => {
    expect(parseTokenResponse(pair, 1000)).toEqual({
      accessToken: "shpat_a",
      accessExpiresAt: 1000 + 3600_000,
      refreshToken: "shprt_r",
      refreshExpiresAt: 1000 + 7776000_000,
      scopes: "read_content,write_content",
    });
  });

  it("refuses a non-expiring token: there would be nothing to refresh it with", () => {
    expect(() => parseTokenResponse({ access_token: "shpat_a" })).toThrow(/no refresh token/);
  });
});

describe("exchangeIdToken", () => {
  it("posts the token-exchange grant for an expiring offline token", async () => {
    mockFetch.mockResolvedValueOnce(ok(pair));
    await exchangeIdToken("fern.myshopify.com", "id.token.jwt", APP);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://fern.myshopify.com/admin/oauth/access_token");
    const p = init.body as URLSearchParams;
    expect(Object.fromEntries(p)).toEqual({
      client_id: "cid",
      client_secret: "shpss_secret",
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "id.token.jwt",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: "1",
    });
  });

  it("turns Shopify's 400 into a retryable invalid-ID-token error", async () => {
    mockFetch.mockResolvedValueOnce(ok({ error: "invalid_subject_token" }, 400));
    await expect(exchangeIdToken("fern.myshopify.com", "x", APP)).rejects.toBeInstanceOf(ShopifyInvalidIdTokenError);
  });

  it("never puts the secret in an error", async () => {
    mockFetch.mockResolvedValueOnce(ok({}, 500));
    await expect(exchangeIdToken("fern.myshopify.com", "x", APP)).rejects.not.toThrow(/shpss_secret/);
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh grant", async () => {
    mockFetch.mockResolvedValueOnce(ok(pair));
    const out = await refreshAccessToken("fern.myshopify.com", "shprt_old", APP);
    expect(Object.fromEntries(mockFetch.mock.calls[0][1].body as URLSearchParams)).toEqual({
      client_id: "cid",
      client_secret: "shpss_secret",
      grant_type: "refresh_token",
      refresh_token: "shprt_old",
    });
    expect(out.refreshToken).toBe("shprt_r");
  });

  it("treats 401 as final and anything else as retryable", async () => {
    mockFetch.mockResolvedValueOnce(ok({ error: "invalid_request" }, 401));
    await expect(refreshAccessToken("fern.myshopify.com", "r", APP)).rejects.toBeInstanceOf(ShopifyRefreshRevokedError);
    mockFetch.mockResolvedValueOnce(ok({}, 503));
    const err = await refreshAccessToken("fern.myshopify.com", "r", APP).catch((e) => e);
    expect(err).not.toBeInstanceOf(ShopifyRefreshRevokedError);
  });
});
