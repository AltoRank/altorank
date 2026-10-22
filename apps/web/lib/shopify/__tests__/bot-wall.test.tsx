import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isShopifyRobots, looksLikeShopify, storefrontWalled } from "../bot-wall";
import { credentialsFrom } from "../store-content";
import { stateFromRun } from "@/lib/onboarding/events";
import { ShopifyWallCta } from "@/components/onboarding/onboarding-progress";

/** The opening of a walled store's robots.txt, 2026-10-21: readable while its homepage is not. */
const SHOPIFY_ROBOTS = `User-agent: PowerMapper
Disallow: *?_pos=*

# we use Shopify as our ecommerce platform
User-agent: *
Disallow: /admin
Disallow: /services/login_with_shop
Sitemap: https://store.example/sitemap.xml`;

const WORDPRESS_ROBOTS = `User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php`;

const fakeFetch = (status: number, body = "", headers: Record<string, string> = {}) =>
  (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

describe("isShopifyRobots", () => {
  it("knows Shopify's generated robots.txt", () => {
    expect(isShopifyRobots(SHOPIFY_ROBOTS)).toBe(true);
    expect(isShopifyRobots("Disallow: /cdn/wpm/*.js")).toBe(true);
  });

  it("does not mistake any other platform's", () => {
    expect(isShopifyRobots(WORDPRESS_ROBOTS)).toBe(false);
    expect(isShopifyRobots("")).toBe(false);
  });
});

describe("looksLikeShopify", () => {
  it("reads robots.txt", async () => {
    expect(await looksLikeShopify("store.example", fakeFetch(200, SHOPIFY_ROBOTS))).toBe(true);
    expect(await looksLikeShopify("blog.example", fakeFetch(200, WORDPRESS_ROBOTS))).toBe(false);
  });

  it("says no when robots.txt is walled too", async () => {
    expect(await looksLikeShopify("store.example", fakeFetch(403, SHOPIFY_ROBOTS))).toBe(false);
  });

  it("says no when the fetch throws", async () => {
    const boom = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await looksLikeShopify("store.example", boom)).toBe(false);
  });
});

describe("storefrontWalled", () => {
  it("counts a refusal or a Cloudflare challenge as a wall", async () => {
    expect(await storefrontWalled("s.example", fakeFetch(403))).toBe(true);
    expect(await storefrontWalled("s.example", fakeFetch(429))).toBe(true);
    expect(await storefrontWalled("s.example", fakeFetch(503, "", { "cf-mitigated": "challenge" }))).toBe(true);
  });

  it("does not count an open storefront or a redirect", async () => {
    expect(await storefrontWalled("s.example", fakeFetch(200))).toBe(false);
    expect(await storefrontWalled("s.example", fakeFetch(302, "", { location: "/password" }))).toBe(false);
  });
});

describe("credentialsFrom", () => {
  it("takes an App Store installation, a custom app's token, or its client pair", () => {
    expect(credentialsFrom({ installationId: "i1", storeUrl: "x" })).toEqual({ installationId: "i1" });
    expect(credentialsFrom({ accessToken: "shpat_x" })).toEqual({ accessToken: "shpat_x" });
    expect(credentialsFrom({ clientId: "c", clientSecret: "s" })).toEqual({ clientId: "c", clientSecret: "s" });
  });

  it("is null for a connection without one", () => {
    expect(credentialsFrom({ storeUrl: "x" })).toBeNull();
    expect(credentialsFrom({ clientId: "c" })).toBeNull();
    expect(credentialsFrom({ accessToken: "  " })).toBeNull();
  });
});

describe("the run screen", () => {
  const run = (cause?: string) =>
    ({
      id: "run-1",
      workspace_id: "ws-1",
      status: "partial",
      phases: [{ phase: "pages", status: "skipped", detail: "walled", ...(cause ? { cause } : {}) }],
      keywords_found: 0,
      planned: [],
      article_id: null,
      error: null,
      started_at: "2026-10-21T04:10:00Z",
      updated_at: "2026-10-21T04:11:00Z",
      finished_at: "2026-10-21T04:11:00Z",
    }) as unknown as Parameters<typeof stateFromRun>[0];

  it("keeps the wall's cause on the step it was given with", () => {
    expect(stateFromRun(run("shopify_wall"), null).steps.find((s) => s.phase === "pages")?.cause).toBe("shopify_wall");
    expect(stateFromRun(run(), null).steps.find((s) => s.phase === "pages")?.cause).toBeUndefined();
    expect(stateFromRun(run("something_else"), null).steps.find((s) => s.phase === "pages")?.cause).toBeUndefined();
  });

  it("points the connection at the Shopify tab of /connect", () => {
    const html = renderToStaticMarkup(<ShopifyWallCta />);
    expect(html).toContain('href="/connect?connect=shopify"');
    expect(html).toContain("Connect Shopify");
  });
});
