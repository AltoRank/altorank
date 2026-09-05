import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "test-key-for-crypto-unit-tests";
});

describe("config encryption", () => {
  it("encrypts the git PAT at rest and round-trips it", async () => {
    const { encryptConfig, decryptConfig } = await import("../crypto");
    const stored = encryptConfig({ type: "git", token: "ghp_secret", owner: "o", repo: "r" });
    expect(stored.token).not.toBe("ghp_secret");
    expect(stored.owner).toBe("o");
    expect(decryptConfig(stored)).toEqual({ type: "git", token: "ghp_secret", owner: "o", repo: "r" });
  });

  it("returns a token stored in plaintext before it was a sensitive field", async () => {
    const { decryptConfig } = await import("../crypto");
    const legacy = { __encrypted: true, type: "git", token: "ghp_legacy_plaintext", owner: "o" };
    expect(decryptConfig(legacy)).toEqual({ type: "git", token: "ghp_legacy_plaintext", owner: "o" });
  });

  it("still fails loudly for a corrupt value in any other secret field", async () => {
    const { decryptConfig } = await import("../crypto");
    expect(() => decryptConfig({ __encrypted: true, applicationPassword: "not-ciphertext" })).toThrow();
  });
});
