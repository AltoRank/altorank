import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const { exchangeIdToken, saveInstallationTokens } = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "cid";
  process.env.SHOPIFY_API_SECRET = "shpss_secret";
  return { exchangeIdToken: vi.fn(), saveInstallationTokens: vi.fn() };
});

vi.mock("@/lib/shopify/tokens", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/tokens")>()),
  exchangeIdToken,
}));
vi.mock("@/lib/shopify/installations", () => ({ saveInstallationTokens }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: null, workspace_id: null } }) }) }) }),
  }),
}));

import { POST } from "../route";
import { ShopifyInvalidIdTokenError } from "@/lib/shopify/tokens";

function idToken(over: Record<string, unknown> = {}, secret = "shpss_secret") {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ iss: "https://fern.myshopify.com/admin", dest: "https://fern.myshopify.com", aud: "cid", exp: now + 60, nbf: now - 1, ...over });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const req = (token?: string) =>
  new Request("https://app.altorank.co/api/shopify/session", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

beforeEach(() => {
  exchangeIdToken.mockReset();
  saveInstallationTokens.mockReset();
});

describe("POST /api/shopify/session", () => {
  it("exchanges a valid ID token and stores the installation", async () => {
    exchangeIdToken.mockResolvedValue({ accessToken: "a" });
    saveInstallationTokens.mockResolvedValue({ id: "inst-1" });
    const res = await POST(req(idToken()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shop: "fern.myshopify.com", installationId: "inst-1", linked: false });
    expect(exchangeIdToken.mock.calls[0][0]).toBe("fern.myshopify.com");
  });

  it.each([
    ["no token", undefined],
    ["a forged token", idToken({}, "attacker")],
    ["an expired token", idToken({ exp: 1, nbf: 0 })],
  ])("asks App Bridge to retry on %s, without calling Shopify", async (_label, token) => {
    const res = await POST(req(token));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Shopify-Retry-Invalid-Session-Request")).toBe("1");
    expect(exchangeIdToken).not.toHaveBeenCalled();
  });

  it("asks App Bridge to retry when Shopify rejects the ID token", async () => {
    exchangeIdToken.mockRejectedValue(new ShopifyInvalidIdTokenError());
    const res = await POST(req(idToken()));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Shopify-Retry-Invalid-Session-Request")).toBe("1");
  });

  it("is a 502, not a retry loop, when Shopify itself fails", async () => {
    exchangeIdToken.mockRejectedValue(new Error("Shopify token exchange failed (500)"));
    expect((await POST(req(idToken()))).status).toBe(502);
  });
});
