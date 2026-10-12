import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decryptTokens,
  encryptTokens,
  exchangeCode,
  GA4_SCOPE,
  getAuthUrl,
  getValidAccessToken,
  grantedIntegrations,
  GSC_SCOPE,
  tokenGrants,
} from "../oauth";

// Search Console and Analytics are separate consents: each connect asks for
// its own scope, and what a token can serve is read from what Google granted.

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost/cb";
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});
afterEach(() => vi.unstubAllGlobals());

describe("getAuthUrl", () => {
  it("asks for one integration's scope, offline, folding in earlier grants", () => {
    const gsc = new URL(getAuthUrl("s", "gsc")).searchParams;
    expect(gsc.get("scope")).toBe(GSC_SCOPE);
    expect(gsc.get("include_granted_scopes")).toBe("true");
    expect(gsc.get("access_type")).toBe("offline");
    expect(gsc.get("prompt")).toBe("consent");

    const ga4 = new URL(getAuthUrl("s", "ga4")).searchParams;
    expect(ga4.get("scope")).toBe(GA4_SCOPE);
  });
});

describe("grantedIntegrations", () => {
  it("reads the integrations from the scopes Google granted", () => {
    expect(grantedIntegrations(GSC_SCOPE)).toEqual(["gsc"]);
    expect(grantedIntegrations(GA4_SCOPE)).toEqual(["ga4"]);
    expect(grantedIntegrations(`${GA4_SCOPE} ${GSC_SCOPE}`)).toEqual(["gsc", "ga4"]);
    expect(grantedIntegrations("openid email")).toEqual([]);
    expect(grantedIntegrations("")).toEqual([]);
  });

  it("reads a token from before the split, which carries no scope, as both", () => {
    expect(grantedIntegrations(undefined)).toEqual(["gsc", "ga4"]);
    const legacy = encryptTokens({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 });
    expect(tokenGrants(legacy, "gsc")).toBe(true);
    expect(tokenGrants(legacy, "ga4")).toBe(true);
  });

  it("does not let a Search Console token pass for Analytics", () => {
    const gscOnly = encryptTokens({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: GSC_SCOPE });
    expect(tokenGrants(gscOnly, "gsc")).toBe(true);
    expect(tokenGrants(gscOnly, "ga4")).toBe(false);
  });
});

describe("the granted scope travels with the token", () => {
  it("exchangeCode keeps the scope Google returned", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: GSC_SCOPE }), { status: 200 }),
    );
    expect((await exchangeCode("code")).scope).toBe(GSC_SCOPE);
  });

  it("a refresh that restates no scope keeps the stored one", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 }));
    const stale = encryptTokens({ access_token: "old", refresh_token: "r", expires_at: 0, scope: GSC_SCOPE });
    let stored = "";
    await getValidAccessToken(stale, async (next) => {
      stored = next;
    });
    expect(decryptTokens(stored)).toMatchObject({ access_token: "new", scope: GSC_SCOPE });
  });

  it("a refresh that restates the scope replaces it", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "new", expires_in: 3600, scope: `${GSC_SCOPE} ${GA4_SCOPE}` }), { status: 200 }),
    );
    const stale = encryptTokens({ access_token: "old", refresh_token: "r", expires_at: 0 });
    let stored = "";
    await getValidAccessToken(stale, async (next) => {
      stored = next;
    });
    expect(grantedIntegrations(decryptTokens(stored).scope)).toEqual(["gsc", "ga4"]);
  });
});
