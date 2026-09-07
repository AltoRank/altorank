import { describe, expect, it } from "vitest";
import { challengeFor, looksLikeVerifier, opaqueToken, verifyPkce } from "../pkce";

describe("pkce", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    // Verifier and S256 challenge from the RFC's own example.
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("verifies a good verifier and rejects a bad one in constant-time shape", () => {
    const verifier = opaqueToken(32) + opaqueToken(8);
    const challenge = challengeFor(verifier);
    expect(looksLikeVerifier(verifier)).toBe(true);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(verifier.slice(0, -1) + "x", challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
  });

  it("opaque tokens are url-safe and distinct", () => {
    const a = opaqueToken();
    const b = opaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
