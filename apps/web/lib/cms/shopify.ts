import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { ShopifyConfig } from "@/lib/types";

const SHOPIFY_API_VERSION = "2025-01";

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

    const res = await fetch(`${this.storeUrl}/admin/api/${SHOPIFY_API_VERSION}/blogs.json`, {
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Shopify blogs fetch failed (${res.status})`);

    const data = await res.json();
    const blogs = data.blogs;
    if (!blogs?.length) throw new Error("No blogs found on Shopify store");

    this.blogId = String(blogs[0].id);
    return this.blogId;
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const blogId = await this.resolveBlogId();

    const res = await fetch(`${this.storeUrl}/admin/api/${SHOPIFY_API_VERSION}/blogs/${blogId}/articles.json`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        article: {
          title: article.title,
          body_html: article.html,
          tags: article.tags?.join(", ") ?? "",
          published: true,
          published_at: article.publishedAt ?? new Date().toISOString(),
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
