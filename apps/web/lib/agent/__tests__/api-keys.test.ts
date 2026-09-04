import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  API_KEY_RANDOM_LENGTH,
  apiKeyState,
  DISPLAY_PREFIX_LENGTH,
  expiryFromDays,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
} from "../api-keys";

describe("generateApiKey", () => {
  it("produces altorank_live_ plus 40 base62 characters", () => {
    const { key } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    const rest = key.slice(API_KEY_PREFIX.length);
    expect(rest).toHaveLength(API_KEY_RANDOM_LENGTH);
    expect(rest).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(seen.size).toBe(200);
  });

  it("stores a sha256 hash and a short display prefix, never the key", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prefix).toBe(key.slice(0, DISPLAY_PREFIX_LENGTH));
    expect(prefix.length).toBeLessThan(key.length);
    expect(hash).not.toContain(key.slice(API_KEY_PREFIX.length));
  });

  it("uses every base62 character across many draws (no rejection-sampling bias)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      for (const ch of generateApiKey().key.slice(API_KEY_PREFIX.length)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(62);
  });
});

describe("hashApiKey", () => {
  it("is deterministic and one-way", () => {
    expect(hashApiKey("altorank_live_abc")).toBe(hashApiKey("altorank_live_abc"));
    expect(hashApiKey("altorank_live_abc")).not.toBe(hashApiKey("altorank_live_abd"));
  });
});

describe("looksLikeApiKey", () => {
  it("accepts a generated key and rejects the rest", () => {
    expect(looksLikeApiKey(generateApiKey().key)).toBe(true);
    expect(looksLikeApiKey(null)).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("fr_live_sk_deadbeef")).toBe(false);
    expect(looksLikeApiKey(API_KEY_PREFIX + "short")).toBe(false);
    expect(looksLikeApiKey(API_KEY_PREFIX + "a".repeat(39) + "!")).toBe(false);
  });
});

describe("apiKeyState", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it("is active with no expiry and no revocation", () => {
    expect(apiKeyState({ revoked_at: null, expires_at: null }, now)).toBe("active");
  });

  it("expires at the instant, not after it", () => {
    expect(apiKeyState({ revoked_at: null, expires_at: "2026-09-04T12:00:00Z" }, now)).toBe("expired");
    expect(apiKeyState({ revoked_at: null, expires_at: "2026-09-04T12:00:01Z" }, now)).toBe("active");
  });

  it("revocation wins over expiry", () => {
    expect(
      apiKeyState({ revoked_at: "2026-09-01T00:00:00Z", expires_at: "2026-01-01T00:00:00Z" }, now),
    ).toBe("revoked");
  });
});

describe("expiryFromDays", () => {
  it("returns null for never and an ISO date otherwise", () => {
    const now = new Date("2026-09-04T00:00:00Z");
    expect(expiryFromDays(null, now)).toBeNull();
    expect(expiryFromDays(30, now)).toBe("2026-10-04T00:00:00.000Z");
  });
});
