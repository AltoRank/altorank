import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const { claims, markShopUninstalled, forgetShop, recordEvent } = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "cid";
  process.env.SHOPIFY_API_SECRET = "shpss_secret";
  return {
    claims: new Set<string>(),
    markShopUninstalled: vi.fn(),
    forgetShop: vi.fn(),
    recordEvent: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: async (row: { webhook_id: string }) => {
        if (claims.has(row.webhook_id)) return { error: { code: "23505", message: "duplicate" } };
        claims.add(row.webhook_id);
        return { error: null };
      },
      delete: () => ({
        eq: async (_col: string, id: string) => {
          claims.delete(id);
          return { error: null };
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/shopify/installations", () => ({ markShopUninstalled, forgetShop }));
vi.mock("@/lib/observability/record", () => ({ recordEvent }));

import { POST } from "../route";
import { SHOPIFY_WEBHOOK_TOPICS } from "@/lib/shopify/webhook-topics";

function delivery(topic: string, opts: { id?: string; secret?: string; shop?: string } = {}) {
  const body = JSON.stringify({ shop_id: 1, shop_domain: opts.shop ?? "fern.myshopify.com" });
  const hmac = createHmac("sha256", opts.secret ?? "shpss_secret").update(body, "utf8").digest("base64");
  return new Request("https://app.altorank.co/api/webhooks/shopify", {
    method: "POST",
    body,
    headers: {
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": opts.shop ?? "fern.myshopify.com",
      "X-Shopify-Webhook-Id": opts.id ?? `wh-${topic}-${Math.random()}`,
    },
  });
}

beforeEach(() => {
  claims.clear();
  markShopUninstalled.mockReset();
  forgetShop.mockReset();
  recordEvent.mockReset();
});

describe("POST /api/webhooks/shopify", () => {
  it("answers a bad signature with 401, which App Store review checks for", async () => {
    const res = await POST(delivery("app/uninstalled", { secret: "wrong" }));
    expect(res.status).toBe(401);
    expect(markShopUninstalled).not.toHaveBeenCalled();
  });

  it("app/uninstalled drops the store's tokens", async () => {
    const res = await POST(delivery("app/uninstalled"));
    expect(res.status).toBe(200);
    expect(markShopUninstalled).toHaveBeenCalledWith(expect.anything(), "fern.myshopify.com");
  });

  it("shop/redact forgets the store", async () => {
    expect((await POST(delivery("shop/redact"))).status).toBe(200);
    expect(forgetShop).toHaveBeenCalledWith(expect.anything(), "fern.myshopify.com");
  });

  it.each(["customers/data_request", "customers/redact"])("%s is acknowledged: no customer data is held", async (topic) => {
    expect((await POST(delivery(topic))).status).toBe(200);
    expect(recordEvent).toHaveBeenCalled();
  });

  it("a redelivery of the same webhook id does nothing twice", async () => {
    await POST(delivery("app/uninstalled", { id: "wh-1" }));
    const again = await POST(delivery("app/uninstalled", { id: "wh-1" }));
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(markShopUninstalled).toHaveBeenCalledTimes(1);
  });

  it("a handler failure releases the claim and asks Shopify to retry", async () => {
    markShopUninstalled.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(delivery("app/uninstalled", { id: "wh-2" }));
    expect(res.status).toBe(500);
    expect(claims.has("wh-2")).toBe(false);
    expect((await POST(delivery("app/uninstalled", { id: "wh-2" }))).status).toBe(200);
  });

  it("refuses a shop header that is not a myshopify.com host", async () => {
    expect((await POST(delivery("app/uninstalled", { shop: "evil.example" }))).status).toBe(400);
  });

  it("handles every topic the app subscribes to", () => {
    expect([...SHOPIFY_WEBHOOK_TOPICS].sort()).toEqual(
      ["app/uninstalled", "customers/data_request", "customers/redact", "shop/redact"].sort(),
    );
  });
});
