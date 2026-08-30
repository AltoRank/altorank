import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { FramerConfig } from "@/lib/types";

const FRAMER_API = "https://api.framer.com/v1";

export class FramerAdapter implements CMSAdapter {
  private siteId: string;
  private collectionId: string;
  private apiToken: string;

  constructor(config: FramerConfig) {
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
    const res = await fetch(
      `${FRAMER_API}/sites/${this.siteId}/collections/${this.collectionId}/items`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          fieldData: {
            name: article.title,
            slug: article.slug,
            content: article.html,
            description: article.metaDescription ?? "",
          },
          isDraft: false,
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Framer publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.id),
      url: data.url ?? `https://${this.siteId}.framer.website/${article.slug}`,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(
      `${FRAMER_API}/sites/${this.siteId}/collections/${this.collectionId}/items/${externalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ isDraft: true }),
      },
    );

    if (!res.ok) throw new Error(`Framer unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${FRAMER_API}/sites/${this.siteId}/collections/${this.collectionId}`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
