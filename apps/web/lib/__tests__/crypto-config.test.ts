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
