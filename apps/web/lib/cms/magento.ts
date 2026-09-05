import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { MagentoConfig } from "@/lib/types";

export class MagentoAdapter implements CMSAdapter {
  private baseUrl: string;
  private adminToken: string;
  private storeCode: string;

  constructor(config: MagentoConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.adminToken = config.adminToken;
    this.storeCode = config.storeCode ?? "default";
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.adminToken}`,
    };
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(`${this.baseUrl}/rest/${this.storeCode}/V1/cmsPage`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        page: {
          title: article.title,
          identifier: article.slug,
          content: article.html,
          // Magento CMS pages have no draft: disabled is the state a page sits
          // in until someone enables it from the admin.
          active: article.publishMode !== "draft",
          meta_description: article.metaDescription ?? "",
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Magento publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.id),
      url: `${this.baseUrl}/${article.slug}`,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/${this.storeCode}/V1/cmsPage/${externalId}`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Magento unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/rest/${this.storeCode}/V1/cmsPage/search?searchCriteria[pageSize]=1`, {
        headers: this.headers(),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
