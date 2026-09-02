import { beforeAll, describe, expect, it } from "vitest";

// The stash is AES-256-GCM under ENCRYPTION_KEY, read lazily by lib/crypto.
// A throwaway key set before the first call is all the module needs.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

const stash = {
  v: 1 as const,
  operator: { id: "11111111-1111-4111-8111-111111111111", email: "helloaltorank@gmail.com" },
  target: { id: "22222222-2222-4222-8222-222222222222", email: "customer@example.com" },
  sessionId: "33333333-3333-4333-8333-333333333333",
  startedAt: "2026-09-02T12:00:00.000Z",
  logId: "44444444-4444-4444-8444-444444444444",
};

describe("impersonation stash", () => {
  it("round-trips through the cookie value", async () => {
    const { encodeStash, decodeStash } = await import("../impersonation-stash");
    const raw = encodeStash(stash);
    expect(raw).not.toContain("customer@example.com");
    expect(decodeStash(raw)).toEqual(stash);
  });

  it("treats a tampered cookie as absent, not as an error", async () => {
    const { encodeStash, decodeStash } = await import("../impersonation-stash");
    const raw = encodeStash(stash);
    // Flip a character in the middle: the GCM tag no longer matches.
    const i = Math.floor(raw.length / 2);
    const flipped = raw.slice(0, i) + (raw[i] === "A" ? "B" : "A") + raw.slice(i + 1);
    expect(decodeStash(flipped)).toBeNull();
  });

  it("rejects anything that is not a stash we wrote", async () => {
    const { decodeStash } = await import("../impersonation-stash");
    const { encrypt } = await import("@/lib/crypto");
    expect(decodeStash(undefined)).toBeNull();
    expect(decodeStash("")).toBeNull();
    expect(decodeStash("not even base64!")).toBeNull();
    // Correctly encrypted, wrong shape: a forged marker with no session binding.
    expect(decodeStash(encrypt(JSON.stringify({ ...stash, sessionId: "" })))).toBeNull();
    expect(decodeStash(encrypt(JSON.stringify({ ...stash, v: 2 })))).toBeNull();
    expect(decodeStash(encrypt(JSON.stringify({ ...stash, operator: { id: "x" } })))).toBeNull();
    expect(decodeStash(encrypt("[]"))).toBeNull();
  });

  it("does not decode under a different key", async () => {
    const { encodeStash, decodeStash } = await import("../impersonation-stash");
    const raw = encodeStash(stash);
    const previous = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "another key entirely";
    try {
      expect(decodeStash(raw)).toBeNull();
    } finally {
      process.env.ENCRYPTION_KEY = previous;
    }
  });
});

describe("sessionIdOf", () => {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

  it("reads session_id out of an access token payload", async () => {
    const { sessionIdOf } = await import("../impersonation-stash");
    const jwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u", session_id: "sess-1" })}.sig`;
    expect(sessionIdOf(jwt)).toBe("sess-1");
  });

  it("returns null for anything that is not a three-part token with the claim", async () => {
    const { sessionIdOf } = await import("../impersonation-stash");
    expect(sessionIdOf("")).toBeNull();
    expect(sessionIdOf("a.b")).toBeNull();
    expect(sessionIdOf(`${b64url({})}.${b64url({ sub: "u" })}.sig`)).toBeNull();
    expect(sessionIdOf(`${b64url({})}.${b64url({ session_id: "" })}.sig`)).toBeNull();
    expect(sessionIdOf("x.!!!not-json!!!.y")).toBeNull();
  });
});
