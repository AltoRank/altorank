import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  return { queryShopify: vi.fn(), row: null as Record<string, unknown> | null };
});
vi.mock("@/lib/cms/shopify", () => ({ queryShopify: m.queryShopify }));

import { encryptConfig } from "@/lib/crypto";
import { htmlToText, lockedStoreContent, storeContentFrom } from "../store-content";

const locked = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://fern.myshopify.com/password" } })) as unknown as typeof fetch;
const open = vi.fn(async () => new Response("<html/>", { status: 200 })) as unknown as typeof fetch;

function db() {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: m.row }) };
  return { from: () => chain } as never;
}

const answer = {
  shop: { name: "Fern & Co", description: "Handmade ceramic planters." },
  pages: { nodes: [{ title: "About", handle: "about", body: "<h1>Our studio</h1><p>We throw every planter by hand.</p><h2>Glazes</h2>", bodySummary: null }] },
  articles: {
    nodes: [
      { title: "Repotting a fig", handle: "repotting", body: "<p>Newest post &amp; tips.</p>", summary: null, blog: { handle: "news" } },
      { title: "Watering", handle: "watering", body: "<p>Second.</p>", summary: null, blog: { handle: "news" } },
      { title: "Old", handle: "old", body: "<p>Third.</p>", summary: null, blog: { handle: "news" } },
    ],
  },
};

beforeEach(() => {
  m.queryShopify.mockReset();
  m.row = { config: encryptConfig({ type: "shopify", storeUrl: "https://fern.myshopify.com", installationId: "inst-1" }) };
});

describe("htmlToText", () => {
  it("drops tags and scripts and decodes the common entities", () => {
    expect(htmlToText("<p>A &amp; B</p><script>x()</script><p>C&nbsp;D</p>")).toBe("A & B\nC D");
  });
});

describe("storeContentFrom", () => {
  it("shapes the shop, its pages and its articles like crawled pages", () => {
    const c = storeContentFrom("fern.myshopify.com", answer);
    expect(c.pages.map((p) => p.url)).toEqual([
      "https://fern.myshopify.com/",
      "https://fern.myshopify.com/pages/about",
      "https://fern.myshopify.com/blogs/news/repotting",
      "https://fern.myshopify.com/blogs/news/watering",
      "https://fern.myshopify.com/blogs/news/old",
    ]);
    expect(c.pages[0]).toMatchObject({ title: "Fern & Co", metaDescription: "Handmade ceramic planters.", status: 200 });
    expect(c.pages[1]).toMatchObject({ h1: ["About", "Our studio"], h2: ["Glazes"] });
    expect(c.pages[1].metaDescription).toContain("We throw every planter by hand.");
    // The voice gets the two newest articles.
    expect(c.articleText).toContain("Repotting a fig");
    expect(c.articleText).toContain("Watering");
    expect(c.articleText).not.toContain("Old");
  });
});

describe("products", () => {
  it("reads what the store sells, with its type and tags as headings", () => {
    const c = storeContentFrom("fern.myshopify.com", {
      shop: { name: "Fern", description: null },
      pages: { nodes: [] },
      products: {
        nodes: [
          { title: "Speckled planter, 20cm", handle: "speckled-planter", description: "Hand-thrown stoneware with a drainage hole.", productType: "Planters", vendor: "Fern", tags: ["ceramic", "indoor"] },
          { title: "", handle: "untitled", description: "skipped" },
        ],
      },
      articles: { nodes: [] },
    });
    const product = c.pages.find((p) => p.url.endsWith("/products/speckled-planter"))!;
    expect(product).toMatchObject({ title: "Speckled planter, 20cm", h2: ["Planters", "ceramic", "indoor"] });
    expect(product.metaDescription).toContain("Hand-thrown stoneware");
    expect(c.text).toContain("Hand-thrown stoneware with a drainage hole.");
    expect(c.pages).toHaveLength(2);
  });
});

describe("boilerplate", () => {
  it("leaves out the pages every store has and none is about", () => {
    const c = storeContentFrom("fern.myshopify.com", {
      shop: { name: "Fern", description: null },
      pages: {
        nodes: [
          { title: "Your Privacy Choices", handle: "your-privacy-choices", body: "<p>We collect personal information</p>" },
          { title: "Contact", handle: "contact", body: "" },
          { title: "Refund policy", handle: "refund-policy", body: "<p>30 days</p>" },
          { title: "Our story", handle: "our-story", body: "<p>Ceramics since 2010.</p>" },
        ],
      },
      articles: { nodes: [] },
    });
    expect(c.pages.map((p) => p.title)).toEqual(["Fern", "Our story"]);
    expect(c.text).not.toContain("personal information");
  });
});

describe("lockedStoreContent", () => {
  it("reads the store through Shopify when the storefront is locked", async () => {
    m.queryShopify.mockImplementation(async (_u: string, _c: unknown, q: string) =>
      q.includes("AltoRankStoreProducts")
        ? { products: { nodes: [{ title: "Planter", handle: "planter", description: "Stoneware.", productType: "Planters", tags: [] }] } }
        : answer,
    );
    const c = await lockedStoreContent(db(), "ws", "fern.myshopify.com", { fetchImpl: locked });
    expect(c?.pages.length).toBe(6);
    expect(m.queryShopify).toHaveBeenCalledWith("https://fern.myshopify.com", { installationId: "inst-1" }, expect.any(String));
    m.queryShopify.mockReset();
  });

  it("still reads pages and articles when products are not approved yet", async () => {
    m.queryShopify.mockImplementation(async (_u: string, _c: unknown, q: string) => {
      if (q.includes("AltoRankStoreProducts")) throw new Error("Shopify: Access denied for products field.");
      return answer;
    });
    const c = await lockedStoreContent(db(), "ws", "fern.myshopify.com", { fetchImpl: locked });
    expect(c?.pages.length).toBe(5);
    m.queryShopify.mockReset();
  });

  it("leaves an open storefront to the crawl", async () => {
    expect(await lockedStoreContent(db(), "ws", "fern.myshopify.com", { fetchImpl: open })).toBeNull();
    expect(m.queryShopify).not.toHaveBeenCalled();
  });

  it("does nothing for a site with no app-installed Shopify connection", async () => {
    m.row = null;
    expect(await lockedStoreContent(db(), "ws", "x.com", { fetchImpl: locked })).toBeNull();
    m.row = { config: encryptConfig({ type: "shopify", storeUrl: "https://fern.myshopify.com", accessToken: "shpat_x" }) };
    expect(await lockedStoreContent(db(), "ws", "fern.myshopify.com", { fetchImpl: locked })).toBeNull();
    expect(m.queryShopify).not.toHaveBeenCalled();
  });

  it("falls back to the crawl when Shopify refuses or the store is empty", async () => {
    m.queryShopify.mockRejectedValueOnce(new Error("Shopify 401"));
    expect(await lockedStoreContent(db(), "ws", "fern.myshopify.com", { fetchImpl: locked })).toBeNull();
    m.queryShopify.mockResolvedValueOnce({ shop: { name: null, description: null }, pages: { nodes: [] }, articles: { nodes: [] } });
    expect(await lockedStoreContent(db(), "ws", "fern.myshopify.com", { fetchImpl: locked })).toBeNull();
  });
});
