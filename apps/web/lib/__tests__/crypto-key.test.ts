import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, encryptionKey } from "../crypto";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ENCRYPTION_KEY", () => {
  it("decodes 64 hex characters as the key itself", () => {
    vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
    expect(encryptionKey()).toEqual(Buffer.from("ab".repeat(32), "hex"));
  });

  it("accepts upper-case hex", () => {
    vi.stubEnv("ENCRYPTION_KEY", "AB".repeat(32));
    expect(encryptionKey()).toEqual(Buffer.from("ab".repeat(32), "hex"));
  });

  /** A 64-character passphrase that is not hex used to decode to a short key. */
  it("hashes a 64-character string that is not hex, and round-trips with it", () => {
    const passphrase = "this-is-a-passphrase-of-exactly-sixty-four-characters-in-length!";
    expect(passphrase).toHaveLength(64);
    vi.stubEnv("ENCRYPTION_KEY", passphrase);
    expect(encryptionKey()).toHaveLength(32);
    expect(decrypt(encrypt("secret"))).toBe("secret");
  });

  it("hashes any other string to 32 bytes", () => {
    vi.stubEnv("ENCRYPTION_KEY", "short");
    expect(encryptionKey()).toHaveLength(32);
    expect(decrypt(encrypt("secret"))).toBe("secret");
  });

  it("refuses an unset key", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => encryptionKey()).toThrow(/ENCRYPTION_KEY/);
  });
});
