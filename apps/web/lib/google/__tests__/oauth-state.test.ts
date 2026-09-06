import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  clearOauthNonce,
  decodeOauthState,
  encodeOauthState,
  newOauthNonce,
  nonceMatches,
  OAUTH_STATE_COOKIE,
  setOauthNonce,
} from "../oauth-state";
import { NextResponse } from "next/server";

const WS = "11111111-1111-1111-1111-111111111111";

describe("google oauth state", () => {
  it("round-trips workspace, integration and nonce", () => {
    const nonce = newOauthNonce();
    expect(decodeOauthState(encodeOauthState(WS, "gsc", nonce))).toEqual({
      workspaceId: WS,
      integrationId: "gsc",
      nonce,
    });
  });

  it("refuses the old two-part state, which carried no nonce", () => {
    expect(decodeOauthState(`${WS}:gsc`)).toBeNull();
    expect(decodeOauthState("account:gsc")).toBeNull();
    expect(decodeOauthState(null)).toBeNull();
    expect(decodeOauthState("")).toBeNull();
  });

  it("matches only an identical nonce, and never a missing one", () => {
    const nonce = newOauthNonce();
    expect(nonceMatches(nonce, nonce)).toBe(true);
    expect(nonceMatches(nonce, newOauthNonce())).toBe(false);
    expect(nonceMatches(nonce, undefined)).toBe(false);
    expect(nonceMatches(undefined, nonce)).toBe(false);
    // A prefix must not pass: the compare is length-checked before the bytes.
    expect(nonceMatches(nonce.slice(0, 8), nonce)).toBe(false);
  });

  it("mints 128 bits of hex", () => {
    const a = newOauthNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newOauthNonce());
  });

  it("sets the cookie httpOnly, lax and short-lived, and clears it again", () => {
    const nonce = newOauthNonce();
    const set = setOauthNonce(NextResponse.redirect("https://accounts.google.com/o/oauth2/v2/auth"), nonce);
    const cookie = set.cookies.get(OAUTH_STATE_COOKIE);
    expect(cookie?.value).toBe(nonce);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/api/auth/google");

    const cleared = clearOauthNonce(NextResponse.redirect("https://app.altorank.co/connect"));
    expect(cleared.cookies.get(OAUTH_STATE_COOKIE)?.value).toBe("");
  });
});

describe("google oauth callback", () => {
  /**
   * The attack this closes: an attacker consents to Google as themselves, keeps
   * the `code`, and gets a signed-in customer to load the callback with it. The
   * customer's browser never started a flow, so it carries no nonce cookie.
   */
  it("refuses a code and state the browser never asked for", async () => {
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(
      new NextRequest(
        `https://app.altorank.co/api/auth/google/callback?code=attacker-code&state=${WS}:gsc:${newOauthNonce()}`,
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=invalid_state");
  });

  it("refuses a state whose nonce does not match the cookie", async () => {
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const request = new NextRequest(
      `https://app.altorank.co/api/auth/google/callback?code=c&state=${WS}:gsc:${newOauthNonce()}`,
    );
    request.cookies.set(OAUTH_STATE_COOKIE, newOauthNonce());
    const res = await GET(request);
    expect(res.headers.get("location")).toContain("error=invalid_state");
  });

  it("still refuses the legacy account-level state, nonce or not", async () => {
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const request = new NextRequest("https://app.altorank.co/api/auth/google/callback?code=c&state=account:gsc");
    request.cookies.set(OAUTH_STATE_COOKIE, newOauthNonce());
    const res = await GET(request);
    expect(res.headers.get("location")).toContain("error=invalid_state");
  });
});
