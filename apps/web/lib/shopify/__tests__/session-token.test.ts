import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyIdToken, ShopifyIdTokenError, bearerToken } from "../session-token";

const APP = { clientId: "client-id-123", clientSecret: "shpss_secret" };
const NOW = 1_800_000_000;

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

function sign(payload: Record<string, unknown>, opts: { secret?: string; alg?: string } = {}): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", opts.secret ?? APP.clientSecret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: "https://fern.myshopify.com/admin",
  dest: "https://fern.myshopify.com",
  aud: APP.clientId,
  sub: "42",
  exp: NOW + 60,
  nbf: NOW - 1,
  iat: NOW - 1,
  jti: "f8912129-1af6-4cad-9ca3-76b0f7621087",
  sid: "abc",
  ...over,
});

describe("verifyShopifyIdToken", () => {
  it("accepts Shopify's token and names the store", () => {
    expect(verifyShopifyIdToken(sign(claims()), APP, NOW)).toEqual({ shop: "fern.myshopify.com", sub: "42", sid: "abc" });
  });

  it.each([
    ["signed with another secret", () => sign(claims(), { secret: "other" }), /signature/],
    ["alg none", () => sign(claims(), { alg: "none" }), /algorithm/],
    ["expired", () => sign(claims({ exp: NOW - 30 })), /expired/],
    ["not valid yet", () => sign(claims({ nbf: NOW + 30 })), /not valid yet/],
    ["for another app", () => sign(claims({ aud: "someone-else" })), /another app/],
    ["iss and dest differ", () => sign(claims({ iss: "https://evil.myshopify.com/admin" })), /differ/],
    ["not a myshopify host", () => sign(claims({ iss: "https://evil.example/admin", dest: "https://evil.example" })), /no Shopify store/],
    ["malformed", () => "a.b", /Malformed/],
  ])("refuses a token %s", (_label, make, message) => {
    expect(() => verifyShopifyIdToken(make(), APP, NOW)).toThrow(ShopifyIdTokenError);
    expect(() => verifyShopifyIdToken(make(), APP, NOW)).toThrow(message);
  });

  it("allows a few seconds of clock skew", () => {
    expect(() => verifyShopifyIdToken(sign(claims({ exp: NOW - 5 })), APP, NOW)).not.toThrow();
    expect(() => verifyShopifyIdToken(sign(claims({ nbf: NOW + 5 })), APP, NOW)).not.toThrow();
  });
});

describe("bearerToken", () => {
  it("reads the Authorization header", () => {
    expect(bearerToken(new Request("https://x", { headers: { Authorization: "Bearer abc.def.ghi" } }))).toBe("abc.def.ghi");
    expect(bearerToken(new Request("https://x"))).toBeNull();
  });
});
