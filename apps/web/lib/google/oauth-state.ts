// ---------------------------------------------------------------------------
// Binding the Google OAuth round trip to the browser that started it
// ---------------------------------------------------------------------------
//
// `state` travels out through Google and comes back through the visitor's
// browser, so it is attacker-controllable: anyone can make a signed-in person
// load /api/auth/google/callback?code=…&state=…. Without something tying the
// return to the departure, an attacker could run the consent screen against
// their OWN Google account, keep the `code`, and then get a victim to load the
// callback with it - writing the attacker's tokens onto the victim's account,
// which then syncs the attacker's Search Console properties into the victim's
// sites. The ownership check in the callback does not stop this: it proves the
// victim owns the workspace, which they do.
//
// So the start of the flow mints a nonce, keeps it in an httpOnly cookie, and
// puts it in `state`. The callback only proceeds when the two match. A person
// who never started a connection has no cookie, and the request is refused.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";

export const OAUTH_STATE_COOKIE = "google_oauth_state";

/** Scoped to the two routes that use it, and short-lived: a consent screen is minutes, not days. */
const COOKIE_PATH = "/api/auth/google";
const COOKIE_MAX_AGE_SECONDS = 15 * 60;

export function newOauthNonce(): string {
  return randomBytes(16).toString("hex");
}

export function setOauthNonce(response: NextResponse, nonce: string): NextResponse {
  response.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

/** One round trip, one nonce: cleared whichever way the callback ends. */
export function clearOauthNonce(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_STATE_COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
  return response;
}

export function nonceMatches(fromState: string | undefined, fromCookie: string | undefined): boolean {
  if (!fromState || !fromCookie) return false;
  const a = Buffer.from(fromState, "utf8");
  const b = Buffer.from(fromCookie, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `workspaceId:integrationId:nonce`, the shape the callback parses. */
export function encodeOauthState(workspaceId: string, integrationId: string, nonce: string): string {
  return `${workspaceId}:${integrationId}:${nonce}`;
}

export function decodeOauthState(
  state: string | null,
): { workspaceId: string; integrationId: string; nonce: string } | null {
  if (!state) return null;
  const [workspaceId, integrationId, nonce] = state.split(":");
  if (!workspaceId || !integrationId || !nonce) return null;
  return { workspaceId, integrationId, nonce };
}
