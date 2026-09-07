// ---------------------------------------------------------------------------
// PKCE and opaque-token helpers for the connector OAuth flow
// ---------------------------------------------------------------------------
//
// Pure functions, no I/O, so the unit tests load them directly. The only
// method supported is S256: "plain" is what PKCE exists to replace, and every
// MCP client (ChatGPT, Claude, the SDK) sends S256.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unguessable opaque string: client ids, authorization codes. */
export function opaqueToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** RFC 7636 §4.2: BASE64URL(SHA256(code_verifier)). */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** RFC 7636 §4.1 verifier shape: 43–128 unreserved characters. */
export function looksLikeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** Constant-time comparison of the recomputed challenge against the stored one. */
export function verifyPkce(verifier: string, storedChallenge: string): boolean {
  if (!looksLikeVerifier(verifier)) return false;
  const a = Buffer.from(challengeFor(verifier));
  const b = Buffer.from(storedChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
