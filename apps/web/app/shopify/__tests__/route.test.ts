import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";

beforeEach(() => {
  process.env.SHOPIFY_API_KEY = "cid_123";
  process.env.SHOPIFY_API_SECRET = "shpss";
});

describe("GET /shopify", () => {
  it("loads App Bridge as the first script in <head>, synchronously, with our client id", async () => {
    const html = await (await GET(new Request("https://app.altorank.co/shopify?shop=fern.myshopify.com"))).text();
    const head = html.slice(0, html.indexOf("</head>"));
    const scripts = [...head.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    expect(scripts[0]).toBe('<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js">');
    expect(head).toContain('<meta name="shopify-api-key" content="cid_123">');
    expect(head.indexOf('name="shopify-api-key"')).toBeLessThan(head.indexOf("app-bridge.js"));
  });

  it("lets exactly this store's admin frame it", async () => {
    const res = await GET(new Request("https://app.altorank.co/shopify?shop=fern.myshopify.com"));
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://admin.shopify.com https://fern.myshopify.com;",
    );
  });

  it("ignores a shop parameter that is not a myshopify.com host", async () => {
    const res = await GET(new Request("https://app.altorank.co/shopify?shop=evil.example"));
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors https://admin.shopify.com;");
  });

  it("says so when the app is not configured", async () => {
    delete process.env.SHOPIFY_API_KEY;
    expect((await GET(new Request("https://app.altorank.co/shopify"))).status).toBe(503);
  });
});
