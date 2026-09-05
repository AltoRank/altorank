/**
 * publishMode: "draft" on the payload has to become the platform's own idea of
 * a draft, per adapter, and omitting it has to keep publishing live - every
 * caller before the field existed relies on that.
 *
 * One file for all twelve, so the question "which destinations honour draft"
 * has one answer, rather than twelve tests interleaved with the adapters'
 * other behaviour in adapters.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WordPressAdapter } from "../wordpress";
import { WooCommerceAdapter } from "../woocommerce";
import { GhostAdapter } from "../ghost";
import { WebflowAdapter } from "../webflow";
import { ShopifyAdapter } from "../shopify";
import { WixAdapter } from "../wix";
import { NotionAdapter } from "../notion";
import { HubSpotAdapter } from "../hubspot";
import { FramerAdapter } from "../framer";
import { MagentoAdapter } from "../magento";
import { WebhookAdapter } from "../webhook";
import { renderPost } from "../git";
import { assertPublishMode, draftSupport, DRAFT_BEHAVIOUR, publishVerb } from "../publish-mode";
import type { PublishPayload } from "../types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

const draft: PublishPayload = {
  title: "Hello",
  html: "<p>world</p>",
  slug: "hello",
  publishMode: "draft",
};
const live: PublishPayload = { ...draft, publishMode: "publish" };
const unspecified: PublishPayload = { title: "Hello", html: "<p>world</p>", slug: "hello" };

/** JSON body of the nth fetch call. */
function body(n = 0): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[n][1].body);
}

describe("WordPress and WooCommerce", () => {
  const wp = new WordPressAdapter({ type: "wordpress", siteUrl: "https://x.test", username: "u", applicationPassword: "p" });
  const woo = new WooCommerceAdapter({ type: "woocommerce", siteUrl: "https://x.test", username: "u", applicationPassword: "p" });

  it.each([
    ["WordPress", wp],
    ["WooCommerce", woo],
  ])("%s: draft is status=draft, otherwise status=publish", async (_, adapter) => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 1, link: "https://x.test/hello" }) });
    await adapter.publish(draft);
    await adapter.publish(live);
    await adapter.publish(unspecified);
    expect(body(0).status).toBe("draft");
    expect(body(1).status).toBe("publish");
    expect(body(2).status).toBe("publish");
  });
});

describe("Ghost", () => {
  const ghost = new GhostAdapter({ type: "ghost", apiUrl: "https://g.test", adminApiKey: "abc:0011" });

  it("draft is status=draft, otherwise published", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ posts: [{ id: "p1", url: "https://g.test/p/1" }] }) });
    await ghost.publish(draft);
    await ghost.publish(unspecified);
    expect((body(0).posts as { status: string }[])[0].status).toBe("draft");
    expect((body(1).posts as { status: string }[])[0].status).toBe("published");
  });
});

describe("Webflow", () => {
  const webflow = new WebflowAdapter({ type: "webflow", siteId: "s", collectionId: "c", apiToken: "t" });

  it("draft stages the item with isDraft and never calls /publish", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "item-1" }) });
    await webflow.publish(draft);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(body(0).isDraft).toBe(true);
  });

  it("live creates then publishes", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "item-1" }) });
    await webflow.publish(unspecified);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(body(0).isDraft).toBe(false);
    expect(mockFetch.mock.calls[1][0]).toMatch(/\/items\/item-1\/publish$/);
  });
});

describe("Shopify", () => {
  const shopify = new ShopifyAdapter({ type: "shopify", storeUrl: "https://s.myshopify.com", accessToken: "t", blogId: "7" });

  it("draft is published=false with no published_at", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ article: { id: 1, handle: "hello" } }) });
    await shopify.publish(draft);
    const article = body(0).article as Record<string, unknown>;
    expect(article.published).toBe(false);
    expect(article).not.toHaveProperty("published_at");
  });

  it("live is published=true with a published_at", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ article: { id: 1, handle: "hello" } }) });
    await shopify.publish(unspecified);
    const article = body(0).article as Record<string, unknown>;
    expect(article.published).toBe(true);
    expect(typeof article.published_at).toBe("string");
  });
});

describe("Wix", () => {
  const wix = new WixAdapter({ type: "wix", accountId: "a", siteId: "s", apiKey: "k" });

  it("draft creates the draft post and stops, claiming no URL", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ draftPost: { id: "d1" } }) });
    const result = await wix.publish(draft);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ externalId: "d1", url: "" });
  });

  it("live takes the second step", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ draftPost: { id: "d1" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ post: { id: "p1", url: "https://w.test/hello" } }) });
    const result = await wix.publish(unspecified);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toMatch(/draft-posts\/d1\/publish$/);
    expect(result.externalId).toBe("p1");
  });
});

describe("Notion", () => {
  it("sets the named Status property to the draft or published option", async () => {
    const notion = new NotionAdapter({
      type: "notion",
      databaseId: "db",
      integrationToken: "t",
      statusProperty: "Stage",
      draftStatus: "In review",
    });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "pg", url: "https://notion.so/pg" }) });
    await notion.publish(draft);
    await notion.publish(live);
    const props0 = body(0).properties as Record<string, { status: { name: string } }>;
    const props1 = body(1).properties as Record<string, { status: { name: string } }>;
    expect(props0.Stage.status.name).toBe("In review");
    expect(props1.Stage.status.name).toBe("Published");
  });

  it("writes no status at all when none is configured", async () => {
    const notion = new NotionAdapter({ type: "notion", databaseId: "db", integrationToken: "t" });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "pg", url: "https://notion.so/pg" }) });
    await notion.publish(live);
    expect(Object.keys(body(0).properties as object)).toEqual(["Name", "Slug"]);
  });
});

describe("HubSpot, Framer, Magento", () => {
  it("HubSpot: DRAFT vs PUBLISHED", async () => {
    const hubspot = new HubSpotAdapter({ type: "hubspot", accessToken: "t", blogId: "b" });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 1, url: "https://h.test/hello" }) });
    await hubspot.publish(draft);
    await hubspot.publish(unspecified);
    expect(body(0).currentState).toBe("DRAFT");
    expect(body(1).currentState).toBe("PUBLISHED");
  });

  it("Framer: isDraft", async () => {
    const framer = new FramerAdapter({ type: "framer", siteId: "s", collectionId: "c", apiToken: "t" });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "i1" }) });
    await framer.publish(draft);
    await framer.publish(unspecified);
    expect(body(0).isDraft).toBe(true);
    expect(body(1).isDraft).toBe(false);
  });

  it("Magento: a draft is a disabled page", async () => {
    const magento = new MagentoAdapter({ type: "magento", baseUrl: "https://m.test", adminToken: "t" });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 1 }) });
    await magento.publish(draft);
    await magento.publish(unspecified);
    expect((body(0).page as { active: boolean }).active).toBe(false);
    expect((body(1).page as { active: boolean }).active).toBe(true);
  });
});

describe("Webhook", () => {
  const webhook = new WebhookAdapter({ type: "webhook", url: "https://hook.test/publish" });

  it("passes publish_mode in the envelope, defaulting to publish", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "1", url: "https://hook.test/1" }) });
    await webhook.publish(draft);
    await webhook.publish(unspecified);
    expect(body(0).publish_mode).toBe("draft");
    expect(body(1).publish_mode).toBe("publish");
  });
});

describe("Git", () => {
  const config = { contentPath: "src/content/blog", frontmatterDefaults: { draft: false } };

  it("draft sets draft: true in the front matter, over a default that says otherwise", () => {
    const { contents } = renderPost(draft, config);
    expect(contents).toMatch(/^draft: true$/m);
    expect(contents).not.toMatch(/^draft: false$/m);
  });

  it("a live publish leaves the front matter to the defaults", () => {
    const { contents } = renderPost(unspecified, config);
    expect(contents).toMatch(/^draft: false$/m);
    expect(renderPost(unspecified, { contentPath: "posts" }).contents).not.toMatch(/^draft:/m);
  });
});

describe("draftSupport", () => {
  it("refuses Notion without a Status property, and says so in words", () => {
    const result = draftSupport({ type: "notion" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cannot save drafts/);
    expect(draftSupport({ type: "notion", statusProperty: "  " }).ok).toBe(false);
    expect(draftSupport({ type: "notion", statusProperty: "Status" }).ok).toBe(true);
  });

  it("accepts every other platform, and has a sentence for each", () => {
    for (const type of Object.keys(DRAFT_BEHAVIOUR) as (keyof typeof DRAFT_BEHAVIOUR)[]) {
      if (type === "notion") continue;
      expect(draftSupport({ type }).ok).toBe(true);
      expect(DRAFT_BEHAVIOUR[type].length).toBeGreaterThan(10);
    }
  });

  it("assertPublishMode only ever refuses a draft", () => {
    const notion = { type: "notion", databaseId: "db", integrationToken: "t" } as const;
    expect(() => assertPublishMode(notion, "draft")).toThrow(/cannot save drafts/);
    expect(() => assertPublishMode(notion, "publish")).not.toThrow();
  });

  it("labels the button by mode", () => {
    expect(publishVerb("draft", "WordPress")).toBe("Save draft to WordPress");
    expect(publishVerb("publish", "WordPress")).toBe("Publish to WordPress");
    expect(publishVerb(undefined, "WordPress")).toBe("Publish to WordPress");
  });
});
