import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { WebhookConfig } from "@/lib/types";
import crypto from "node:crypto";

/**
 * Generic webhook adapter — POSTs article data to a user-defined URL.
 * Supports optional HMAC-SHA256 signing for payload verification
 * and custom headers for auth.
 */
export class WebhookAdapter implements CMSAdapter {
  private url: string;
  private secret: string | undefined;
  private customHeaders: Record<string, string>;

  constructor(config: WebhookConfig) {
    this.url = config.url;
    this.secret = config.secret;
    this.customHeaders = config.headers ?? {};
  }

  private sign(payload: string): string | undefined {
    if (!this.secret) return undefined;
    return crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const body = JSON.stringify({
      action: "publish",
      // What the connection asked for. The receiver is the CMS here, so it is
      // the receiver that decides what a draft looks like on its side.
      publishMode: article.publishMode ?? "publish",
      article: {
        title: article.title,
        html: article.html,
        slug: article.slug,
        metaDescription: article.metaDescription,
        tags: article.tags,
        publishedAt: article.publishedAt ?? new Date().toISOString(),
      },
    });

    const signature = this.sign(body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.customHeaders,
    };

    if (signature) {
      headers["X-Webhook-Signature"] = `sha256=${signature}`;
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Webhook publish failed (${res.status}): ${err}`);
    }

    // Try to extract id/url from response, but don't require it
    let externalId = "";
    let url = "";
    try {
      const data = await res.json();
      externalId = String(data.id ?? data.externalId ?? "");
      url = data.url ?? data.link ?? "";
    } catch {
      // Response may not be JSON — that's fine
    }

    return { externalId, url };
  }

  async unpublish(externalId: string): Promise<void> {
    const body = JSON.stringify({
      action: "unpublish",
      externalId,
    });

    const signature = this.sign(body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.customHeaders,
    };

    if (signature) {
      headers["X-Webhook-Signature"] = `sha256=${signature}`;
    }

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body,
    });

    if (!res.ok)
      throw new Error(`Webhook unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const body = JSON.stringify({ action: "test" });
      const signature = this.sign(body);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.customHeaders,
      };

      if (signature) {
        headers["X-Webhook-Signature"] = `sha256=${signature}`;
      }

      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body,
      });

      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
