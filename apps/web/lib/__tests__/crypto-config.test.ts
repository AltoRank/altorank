import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, encryptConfig, decryptConfig } from "../crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

describe("config encryption versions", () => {
  it("encrypts `token` on new rows and marks them with the current version", () => {
    const stored = encryptConfig({ type: "wordpress-plugin", siteUrl: "https://x", token: "ab".repeat(32) });
    expect(stored.__encrypted).toBe(3);
    expect(stored.token).not.toBe("ab".repeat(32));
    expect(stored.siteUrl).toBe("https://x");
    expect(decryptConfig(stored)).toEqual({ type: "wordpress-plugin", siteUrl: "https://x", token: "ab".repeat(32) });
  });

  it("encrypts a Shopify client secret and leaves the client id readable", () => {
    const stored = encryptConfig({ type: "shopify", storeUrl: "https://s.myshopify.com", clientId: "cid", clientSecret: "shh" });
    expect(stored.clientId).toBe("cid");
    expect(stored.clientSecret).not.toBe("shh");
    expect(decryptConfig(stored)).toEqual({ type: "shopify", storeUrl: "https://s.myshopify.com", clientId: "cid", clientSecret: "shh" });
  });

  it("reads a version-2 row without touching fields it did not encrypt", () => {
    const v2 = { __encrypted: 2, type: "shopify", storeUrl: "https://s", accessToken: encrypt("tok"), clientSecret: "never-encrypted-in-v2" };
    expect(decryptConfig(v2)).toEqual({ type: "shopify", storeUrl: "https://s", accessToken: "tok", clientSecret: "never-encrypted-in-v2" });
  });

  it("reads a version-1 git row whose token was stored in the clear", () => {
    const legacy = { __encrypted: true, type: "git", token: "ghp_plain", owner: "o", repo: "r" };
    expect(decryptConfig(legacy)).toEqual({ type: "git", token: "ghp_plain", owner: "o", repo: "r" });
  });

  it("still decrypts version-1 fields that were encrypted", () => {
    const legacy = {
      __encrypted: true,
      type: "wordpress",
      siteUrl: "https://x",
      username: encrypt("admin"),
      applicationPassword: encrypt("pw"),
    };
    expect(decryptConfig(legacy)).toEqual({ type: "wordpress", siteUrl: "https://x", username: "admin", applicationPassword: "pw" });
  });

  it("passes unencrypted rows through untouched", () => {
    const plain = { type: "webhook", url: "https://h" };
    expect(decryptConfig(plain)).toBe(plain);
  });
});

describe("a connection's config holds plain secrets only", () => {
  it("refuses a config field that decrypts to a stored credential record", () => {
    const records = [
      JSON.stringify({ access_token: "a", refresh_token: "r", expiry_date: 1, scope: "s" }),
      JSON.stringify({ apiKey: "bing" }),
      ` ${JSON.stringify({ refresh_token: "r" })}`,
    ];
    for (const plain of records) {
      for (const field of ["applicationPassword", "username", "token", "secret", "apiKey"]) {
        const row = { __encrypted: 3, type: "wordpress", siteUrl: "https://x", [field]: encrypt(plain) };
        expect(() => decryptConfig(row)).toThrow(/Reconnect it/);
      }
    }
    const v1 = { __encrypted: true, type: "webhook", url: "https://x", secret: encrypt(records[0]) };
    expect(() => decryptConfig(v1)).toThrow(/Reconnect it/);
  });

  it("still reads secrets that merely look structured", () => {
    for (const plain of ['{"not":"a credential"}', "{not json", "[1,2]", "plain-secret"]) {
      const row = { __encrypted: 3, type: "webhook", url: "https://x", secret: encrypt(plain) };
      expect(decryptConfig(row).secret).toBe(plain);
    }
  });
});
