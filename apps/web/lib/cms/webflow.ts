import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { WebflowConfig } from "@/lib/types";

const WEBFLOW_API = "https://api.webflow.com/v2";

export class WebflowAdapter implements CMSAdapter {
  private siteId: string;
  private collectionId: string;
  private apiToken: string;

  constructor(config: WebflowConfig) {
    this.siteId = config.siteId;
    this.collectionId = config.collectionId;
    this.apiToken = config.apiToken;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const draft = article.publishMode === "draft";
    const res = await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          // A draft item is staged in the collection and never pushed to the
          // live site; the publish call below is what would make it public.
          isDraft: draft,
          fieldData: {
            name: article.title,
            slug: article.slug,
            "post-body": article.html,
            "post-summary": article.metaDescription ?? "",
          },
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Webflow publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    const itemId = data.id ?? data._id;

    // Publish the item live - unless the connection asked for a draft, in
    // which case staging it is the whole job.
    if (!draft) {
      await fetch(
        `${WEBFLOW_API}/collections/${this.collectionId}/items/${itemId}/publish`,
        { method: "POST", headers: this.headers() },
      );
    }

    return {
      externalId: String(itemId),
      url: `https://${this.siteId}.webflow.io/${article.slug}`,
    };
  }

  /** Edit the item in place, then publish it so the change goes live. */
  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items/${externalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          fieldData: {
            name: article.title,
            "post-body": article.html,
            "post-summary": article.metaDescription ?? "",
          },
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Webflow update failed (${res.status}): ${err}`);
    }
    await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items/${externalId}/publish`,
      { method: "POST", headers: this.headers() },
    );
    return {
      externalId,
      url: `https://${this.siteId}.webflow.io/${article.slug}`,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items/${externalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ fieldData: { _archived: true } }),
      },
    );

    if (!res.ok) throw new Error(`Webflow unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${WEBFLOW_API}/collections/${this.collectionId}`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
