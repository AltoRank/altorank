import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseShopDomain } from "../shop-domain";
import { verifyShopifyWebhook } from "../webhook-hmac";
import { SHOPIFY_COMPLIANCE_TOPICS, SHOPIFY_EVENT_TOPICS } from "../webhook-topics";
import { SHOPIFY_API_VERSION } from "../env";
import { SHOPIFY_REQUIRED_SCOPES } from "@/lib/cms/shopify";

describe("normaliseShopDomain", () => {
  it.each([
    ["fern.myshopify.com", "fern.myshopify.com"],
    ["https://Fern.myshopify.com/", "fern.myshopify.com"],
    ["fern-2.myshopify.com", "fern-2.myshopify.com"],
  ])("accepts %s", (input, out) => expect(normaliseShopDomain(input)).toBe(out));

  it.each(["", "fern.com", "evil.example/admin", "fern.myshopify.com.evil.com", "-x.myshopify.com", "a b.myshopify.com", null])(
    "refuses %s",
    (input) => expect(normaliseShopDomain(input)).toBeNull(),
  );
});

describe("verifyShopifyWebhook", () => {
  const body = JSON.stringify({ shop_id: 1, shop_domain: "fern.myshopify.com" });
  const hmac = createHmac("sha256", "shpss_secret").update(body, "utf8").digest("base64");

  it("accepts Shopify's signature over the raw body", () => {
    expect(verifyShopifyWebhook(body, hmac, "shpss_secret")).toBe(true);
  });

  it("refuses a missing, wrong or re-serialised signature", () => {
    expect(verifyShopifyWebhook(body, null, "shpss_secret")).toBe(false);
    expect(verifyShopifyWebhook(body, hmac, "other")).toBe(false);
    expect(verifyShopifyWebhook(JSON.stringify(JSON.parse(body), null, 2), hmac, "shpss_secret")).toBe(false);
  });
});

/**
 * shopify.app.toml is what Shopify reads; these constants are what the code
 * does. A scope or topic added on one side only is a failed review or a
 * webhook nobody handles, so the two are compared here.
 */
describe("shopify.app.toml agrees with the code", () => {
  const toml = readFileSync(join(__dirname, "../../../../../shopify/shopify.app.toml"), "utf8");
  const list = (key: string) =>
    (new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(toml)?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean);

  it("asks for exactly the adapter's scopes", () => {
    const scopes = /^scopes\s*=\s*"([^"]*)"/m.exec(toml)?.[1].split(",").map((s) => s.trim());
    expect(scopes).toEqual([...SHOPIFY_REQUIRED_SCOPES]);
  });

  it("subscribes to every topic the route handles, the three privacy topics included", () => {
    expect(list("topics").sort()).toEqual([...SHOPIFY_EVENT_TOPICS].sort());
    expect(list("compliance_topics").sort()).toEqual([...SHOPIFY_COMPLIANCE_TOPICS].sort());
  });

  it("pins the same API version as the adapter", () => {
    expect(/^api_version\s*=\s*"([^"]*)"/m.exec(toml)?.[1]).toBe(SHOPIFY_API_VERSION);
  });

  it("is an embedded app served from /shopify", () => {
    expect(toml).toMatch(/^embedded = true$/m);
    expect(toml).toMatch(/^application_url = "https:\/\/app\.altorank\.co\/shopify"$/m);
  });
});
