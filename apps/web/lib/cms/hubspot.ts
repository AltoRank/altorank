import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { HubSpotConfig } from "@/lib/types";

const HUBSPOT_API = "https://api.hubapi.com";

export class HubSpotAdapter implements CMSAdapter {
  private accessToken: string;
  private blogId: string | undefined;

  constructor(config: HubSpotConfig) {
    this.accessToken = config.accessToken;
    this.blogId = config.blogId;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private async resolveBlogId(): Promise<string> {
    if (this.blogId) return this.blogId;

    const res = await fetch(
      `${HUBSPOT_API}/cms/v3/blogs/posts?limit=1`,
      { headers: this.headers() },
    );

    if (!res.ok) throw new Error(`HubSpot blogs fetch failed (${res.status})`);

    const data = await res.json();
    const results = data.results;
    if (results?.length && results[0].contentGroupId) {
      this.blogId = String(results[0].contentGroupId);
      return this.blogId;
    }

    throw new Error("No blogs found on HubSpot — set blogId manually");
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const blogId = await this.resolveBlogId();

    const res = await fetch(`${HUBSPOT_API}/cms/v3/blogs/posts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: article.title,
        slug: article.slug,
        postBody: article.html,
        contentGroupId: blogId,
        metaDescription: article.metaDescription ?? "",
        currentState: article.publishMode === "draft" ? "DRAFT" : "PUBLISHED",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HubSpot publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.id),
      url: data.url ?? data.absoluteUrl ?? "",
    };
  }

  /**
   * Rewrite the post in place.
   *
   * Without this a HubSpot connection - draft by default - hit core.ts's
   * "cannot be updated in place from here" on the second press of Publish,
   * with nothing else offered. The blog-post resource has a PATCH.
   */
  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(`${HUBSPOT_API}/cms/v3/blogs/posts/${externalId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        name: article.title,
        slug: article.slug,
        postBody: article.html,
        metaDescription: article.metaDescription ?? "",
        currentState: article.publishMode === "draft" ? "DRAFT" : "PUBLISHED",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HubSpot update failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.id ?? externalId),
      url: data.url ?? data.absoluteUrl ?? "",
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(
      `${HUBSPOT_API}/cms/v3/blogs/posts/${externalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ currentState: "DRAFT" }),
      },
    );

    if (!res.ok) throw new Error(`HubSpot unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${HUBSPOT_API}/cms/v3/blogs/posts?limit=1`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
