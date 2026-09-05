// ---------------------------------------------------------------------------
// Generic webhook: POST the article to a URL the customer controls
// ---------------------------------------------------------------------------
//
// PAYLOAD CONTRACT
//
// Every request is a JSON POST to the configured URL with these headers:
//
//   Content-Type:        application/json
//   Authorization:       Bearer <secret>          when a secret is configured
//   X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed by
//                        the secret>              when a secret is configured
//   plus any custom headers from the connection
//
// and one of these bodies, discriminated by `event`:
//
//   { "event": "publish_articles", "publishMode": "draft" | "publish", "articles": [ Article, ... ] }
//       New articles to publish. Always an array, even for one article, so a
//       consumer written for the batch case needs no second code path.
//       `publishMode` is what the connection asked for; your endpoint decides
//       what a draft looks like on its side.
//   { "event": "update_article", "publishMode": "draft" | "publish", "article": Article }
//       An article that already went out and has changed (a refresh, or a
//       retry). Match it on `id`, or on `slug` if you did not keep ids.
//   { "event": "unpublish_article", "article": { "id": "<id>" } }
//       Take it down. `id` is whatever your endpoint returned as `id` when it
//       accepted the article, or our article id if it returned nothing.
//   { "event": "test" }
//       Sent when the connection is saved. Reply 2xx and do nothing.
//
// Article:
//   {
//     "id":               "<our article id>",
//     "title":            "...",
//     "content_markdown": "...",      Markdown with front matter
//     "content_html":     "<p>...",
//     "meta_description": "..." | null,
//     "created_at":       "2026-09-04T10:00:00.000Z",
//     "image_url":        "https://..." | null,   featured image
//     "slug":             "kebab-case",
//     "tags":             ["..."]
//   }
//
// Response: any 2xx. If the body is JSON with `id` and/or `url`, they are
// stored as the article's external id and public URL.
//
// DELIVERY
//
// Three attempts with backoff (0.5s, 2s) on network errors, 429 and 5xx. A 4xx
// other than 429 is the endpoint saying no, and is not retried. Each attempt
// is reported through `AdapterContext.onDelivery`, which the publish core turns
// into a publish_log row, so the log shows every try and not only the last.

import type {
  AdapterContext,
  CMSAdapter,
  DeliveryAttempt,
  PublishPayload,
  PublishResult,
} from "./types";
import type { WebhookConfig } from "@/lib/types";
import crypto from "node:crypto";

export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
export const RETRY_DELAYS_MS = [500, 2000];

/** The article as the contract above describes it. */
export function webhookArticle(article: PublishPayload) {
  return {
    id: article.id ?? null,
    title: article.title,
    content_markdown: article.markdown ?? "",
    content_html: article.html,
    meta_description: article.metaDescription ?? null,
    created_at: article.createdAt ?? article.publishedAt ?? new Date().toISOString(),
    image_url: article.featuredImageUrl ?? null,
    slug: article.slug,
    tags: article.tags ?? [],
  };
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WebhookAdapter implements CMSAdapter {
  private url: string;
  private secret: string | undefined;
  private customHeaders: Record<string, string>;
  private onDelivery?: AdapterContext["onDelivery"];

  constructor(config: WebhookConfig, context: AdapterContext = {}) {
    this.url = config.url;
    this.secret = config.secret;
    this.customHeaders = config.headers ?? {};
    this.onDelivery = context.onDelivery;
  }

  private headersFor(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.customHeaders,
    };
    if (this.secret) {
      headers["Authorization"] = `Bearer ${this.secret}`;
      headers["X-Webhook-Signature"] =
        `sha256=${crypto.createHmac("sha256", this.secret).update(body).digest("hex")}`;
    }
    return headers;
  }

  private async report(attempt: DeliveryAttempt) {
    try {
      await this.onDelivery?.(attempt);
    } catch {
      // The log must never decide whether the article ships.
    }
  }

  /**
   * POST with retries. Resolves with the successful response; throws with the
   * last failure once the attempts are used up or the endpoint answered with a
   * non-retryable status.
   */
  private async deliver(body: string, what: string): Promise<Response> {
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(this.url, { method: "POST", headers: this.headersFor(body), body });
      } catch (e) {
        lastError = (e as Error).message;
      }

      if (res?.ok) {
        await this.report({ attempt, maxAttempts: MAX_ATTEMPTS, ok: true, status: res.status });
        return res;
      }

      if (res) {
        const text = await res.text().catch(() => "");
        lastError = `HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ""}`;
      }
      await this.report({
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        ok: false,
        status: res?.status,
        error: lastError,
      });

      if (res && !retryable(res.status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
    }
    throw new Error(`Webhook ${what} failed: ${lastError}`);
  }

  private async send(payload: unknown, what: string): Promise<PublishResult> {
    const body = JSON.stringify(payload);
    const res = await this.deliver(body, what);

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

  async publish(article: PublishPayload): Promise<PublishResult> {
    const result = await this.send(
      // What the connection asked for. The receiver is the CMS here, so it is
      // the receiver that decides what a draft looks like on its side.
      { event: "publish_articles", publishMode: article.publishMode ?? "publish", articles: [webhookArticle(article)] },
      "publish",
    );
    // An endpoint that returns no id gets ours, so an update can name it.
    return { ...result, externalId: result.externalId || article.id || "" };
  }

  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const result = await this.send(
      { event: "update_article", publishMode: article.publishMode ?? "publish", article: { ...webhookArticle(article), id: article.id ?? externalId } },
      "update",
    );
    return { ...result, externalId: result.externalId || externalId };
  }

  async unpublish(externalId: string): Promise<void> {
    await this.deliver(
      JSON.stringify({ event: "unpublish_article", article: { id: externalId } }),
      "unpublish",
    );
  }

  /** One attempt, no retries: a connection test should answer quickly. */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const body = JSON.stringify({ event: "test" });
      const res = await fetch(this.url, { method: "POST", headers: this.headersFor(body), body });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
