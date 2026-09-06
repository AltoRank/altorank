import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleReconnectError, isGoogleReconnectError, refreshFailureNeedsReconnect, refreshTokens } from "../oauth";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost/cb";
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("refreshFailureNeedsReconnect", () => {
  it("is invalid_grant on a 400, or any 401", () => {
    expect(refreshFailureNeedsReconnect(400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }))).toBe(true);
    expect(refreshFailureNeedsReconnect(400, "error=invalid_grant")).toBe(true);
    expect(refreshFailureNeedsReconnect(401, JSON.stringify({ error: "invalid_client" }))).toBe(true);
  });
  it("is not a 5xx, a rate limit or a 400 for something else", () => {
    expect(refreshFailureNeedsReconnect(500, "Internal error")).toBe(false);
    expect(refreshFailureNeedsReconnect(429, JSON.stringify({ error: "rate_limit_exceeded" }))).toBe(false);
    expect(refreshFailureNeedsReconnect(400, JSON.stringify({ error: "invalid_request" }))).toBe(false);
  });
});

describe("refreshTokens", () => {
  it("throws a GoogleReconnectError when Google refuses the refresh token", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }));
    const err = await refreshTokens("dead").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleReconnectError);
    expect(isGoogleReconnectError(err)).toBe(true);
    expect(String(err.message)).toContain("Reconnect Google");
  });
  it("throws a plain error for a transient failure, so tomorrow's run tries again", async () => {
    mockFetch.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    const err = await refreshTokens("fine").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isGoogleReconnectError(err)).toBe(false);
    expect(String(err.message)).toContain("Google token refresh failed");
  });
  it("keeps the refresh token when the refresh succeeds", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 }));
    const t = await refreshTokens("keep-me");
    expect(t.access_token).toBe("new");
    expect(t.refresh_token).toBe("keep-me");
  });
});
