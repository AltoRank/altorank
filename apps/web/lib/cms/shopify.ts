import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { ShopifyConfig } from "@/lib/types";

const SHOPIFY_API_VERSION = "2025-01";

/**
 * Every call this adapter makes is to /blogs.json and /blogs/{id}/articles.json,
 * which Shopify files under the `content` scope pair. Nothing else is asked
 * for, and the connect dialog reads this list rather than restating it.
 * https://shopify.dev/docs/api/usage/access-scopes
 */
export const SHOPIFY_REQUIRED_SCOPES = ["read_content", "write_content"] as const;

export interface ShopifyBlog {
  id: string;
  title: string;
  handle: string;
}

/**
 * The store's blogs. Shared by the adapter (to default to the first one) and
 * the connect dialog (to let the person pick), so both see the same list.
 */
export async function listShopifyBlogs(storeUrl: string, accessToken: string): Promise<ShopifyBlog[]> {
  const base = storeUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/admin/api/${SHOPIFY_API_VERSION}/blogs.json`, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify ${res.status}${err ? `: ${err}` : ""}`);
  }
  const data = (await res.json()) as {
    blogs?: Array<{ id: number | string; title?: string; handle?: string }>;
  };
  return (data.blogs ?? []).map((b) => ({
    id: String(b.id),
    title: b.title ?? b.handle ?? String(b.id),
    handle: b.handle ?? "",
  }));
}

export class ShopifyAdapter implements CMSAdapter {
  private storeUrl: string;
  private accessToken: string;
  private blogId: string | undefined;

  constructor(config: ShopifyConfig) {
    this.storeUrl = config.storeUrl.replace(/\/+$/, "");
    this.accessToken = config.accessToken;
    this.blogId = config.blogId;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": this.accessToken,
    };
  }

  private async resolveBlogId(): Promise<string> {
    if (this.blogId) return this.blogId;

    const blogs = await listShopifyBlogs(this.storeUrl, this.accessToken);
    if (!blogs.length) throw new Error("No blogs found on Shopify store");

    this.blogId = blogs[0].id;
    return this.blogId;
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const blogId = await this.resolveBlogId();
    const draft = article.publishMode === "draft";

    const res = await fetch(`${this.storeUrl}/admin/api/${SHOPIFY_API_VERSION}/blogs/${blogId}/articles.json`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        article: {
          title: article.title,
          body_html: article.html,
          tags: article.tags?.join(", ") ?? "",
          // An unpublished article is Shopify's draft: it exists in the admin
          // and is hidden from the storefront until someone sets it visible.
          published: !draft,
          ...(draft ? {} : { published_at: article.publishedAt ?? new Date().toISOString() }),
          summary_html: article.metaDescription ? `<p>${article.metaDescription}</p>` : undefined,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Shopify publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.article.id),
      url: data.article.url ?? `${this.storeUrl}/blogs/${blogId}/${data.article.handle}`,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const blogId = await this.resolveBlogId();

    const res = await fetch(`${this.storeUrl}/admin/api/${SHOPIFY_API_VERSION}/blogs/${blogId}/articles/${externalId}.json`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Shopify unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.storeUrl}/admin/api/${SHOPIFY_API_VERSION}/blogs.json`, {
        headers: this.headers(),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
