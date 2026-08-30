import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { WooCommerceConfig } from "@/lib/types";

/**
 * WooCommerce adapter — extends the WordPress REST API pattern.
 * WooCommerce sites are WordPress sites, so blog posts use the
 * same /wp-json/wp/v2/posts endpoint with Basic auth.
 */
export class WooCommerceAdapter implements CMSAdapter {
  private baseUrl: string;
  private auth: string;

  constructor(config: WooCommerceConfig) {
    this.baseUrl = config.siteUrl.replace(/\/+$/, "");
    this.auth = Buffer.from(
      `${config.username}:${config.applicationPassword}`,
    ).toString("base64");
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${this.auth}`,
      },
      body: JSON.stringify({
        title: article.title,
        content: article.html,
        slug: article.slug,
        status: "publish",
        excerpt: article.metaDescription ?? "",
        ...(article.tags?.length && { tags: article.tags }),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WooCommerce publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.id),
      url: data.link,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/wp-json/wp/v2/posts/${externalId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${this.auth}`,
        },
        body: JSON.stringify({ status: "draft" }),
      },
    );

    if (!res.ok)
      throw new Error(`WooCommerce unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${this.baseUrl}/wp-json/wp/v2/posts?per_page=1`,
        { headers: { Authorization: `Basic ${this.auth}` } },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
