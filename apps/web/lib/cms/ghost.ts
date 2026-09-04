import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { GhostConfig } from "@/lib/types";
import crypto from "node:crypto";

/**
 * Ghost Admin API adapter.
 *
 * Ghost admin keys are in the format `{id}:{secret}` — we split them and
 * generate a short-lived JWT (iat-only, 5 min expiry) signed with the secret
 * portion using HMAC-SHA256. No external JWT library needed.
 */
export class GhostAdapter implements CMSAdapter {
  private apiUrl: string;
  private keyId: string;
  private secret: Buffer;

  constructor(config: GhostConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    const [id, secret] = config.adminApiKey.split(":");
    if (!id || !secret) {
      throw new Error("Ghost admin key must be in format {id}:{secret}");
    }
    this.keyId = id;
    this.secret = Buffer.from(secret, "hex");
  }

  private makeJwt(): string {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid: this.keyId }),
    ).toString("base64url");

    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }),
    ).toString("base64url");

    const signature = crypto
      .createHmac("sha256", this.secret)
      .update(`${header}.${payload}`)
      .digest("base64url");

    return `${header}.${payload}.${signature}`;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Ghost ${this.makeJwt()}`,
    };
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(
      `${this.apiUrl}/ghost/api/admin/posts/?source=html`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          posts: [
            {
              title: article.title,
              slug: article.slug,
              html: article.html,
              status: article.publishMode === "draft" ? "draft" : "published",
              meta_description: article.metaDescription ?? "",
              tags: article.tags?.map((t) => ({ name: t })) ?? [],
            },
          ],
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ghost publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    const post = data.posts[0];
    return {
      externalId: post.id,
      url: post.url,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    // Ghost requires an updated_at for PUT — fetch current value first
    const getRes = await fetch(
      `${this.apiUrl}/ghost/api/admin/posts/${externalId}/`,
      { headers: this.headers() },
    );

    if (!getRes.ok) throw new Error(`Ghost fetch failed (${getRes.status})`);

    const getData = await getRes.json();
    const updatedAt = getData.posts[0].updated_at;

    const res = await fetch(
      `${this.apiUrl}/ghost/api/admin/posts/${externalId}/`,
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({
          posts: [{ status: "draft", updated_at: updatedAt }],
        }),
      },
    );

    if (!res.ok) throw new Error(`Ghost unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${this.apiUrl}/ghost/api/admin/posts/?limit=1`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
