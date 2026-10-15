import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const { exchangeIdToken, saveInstallationTokens, provisionShop, startShopFirstLook, dispatchWorker } = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "cid";
  process.env.SHOPIFY_API_SECRET = "shpss_secret";
  return {
    exchangeIdToken: vi.fn(),
    saveInstallationTokens: vi.fn(),
    provisionShop: vi.fn(),
    startShopFirstLook: vi.fn(),
    dispatchWorker: vi.fn(),
  };
});

vi.mock("@/lib/shopify/tokens", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/tokens")>()),
  exchangeIdToken,
}));
vi.mock("@/lib/shopify/installations", () => ({ saveInstallationTokens }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { shop_gid: null } }) }) }) }),
  }),
}));
vi.mock("@/lib/shopify/provision", () => ({ provisionShop }));
vi.mock("@/lib/shopify/first-look", () => ({ startShopFirstLook }));
vi.mock("@/lib/onboarding/run-dispatch", () => ({ dispatchWorker }));
vi.mock("@/lib/shopify/billing", () => ({ syncShopifyBilling: async () => ({ resume: null }) }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: async () => true }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => fn(),
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
  for (const m of [exchangeIdToken, saveInstallationTokens, provisionShop, startShopFirstLook, dispatchWorker]) m.mockReset();
  provisionShop.mockResolvedValue({ accountId: "acc", workspaceId: "ws", created: false, ownerReachable: true });
});

describe("POST /api/shopify/session", () => {
  it("exchanges a valid ID token, stores the installation and sets the store up", async () => {
    exchangeIdToken.mockResolvedValue({ accessToken: "a" });
    saveInstallationTokens.mockResolvedValue({ id: "inst-1" });
    const res = await POST(req(idToken()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shop: "fern.myshopify.com", installationId: "inst-1", created: false });
    expect(exchangeIdToken.mock.calls[0][0]).toBe("fern.myshopify.com");
    expect(provisionShop).toHaveBeenCalledWith(expect.anything(), { id: "inst-1", shop: "fern.myshopify.com" });
    // An existing store does not get a second first look.
    expect(startShopFirstLook).not.toHaveBeenCalled();
  });

  it("starts the first look for a store opening the app for the first time", async () => {
    exchangeIdToken.mockResolvedValue({ accessToken: "a" });
    saveInstallationTokens.mockResolvedValue({ id: "inst-1" });
    provisionShop.mockResolvedValue({ accountId: "acc", workspaceId: "ws", created: true, ownerReachable: true });
    startShopFirstLook.mockResolvedValue({ runId: "run-1", created: true });
    await POST(req(idToken()));
    expect(startShopFirstLook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "acc", workspaceId: "ws" }));
    expect(dispatchWorker).toHaveBeenCalledWith("run-1");
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
