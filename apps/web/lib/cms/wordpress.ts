// ---------------------------------------------------------------------------
// WordPress over the core REST API, with an application password
// ---------------------------------------------------------------------------
//
// The no-plugin path. It gets the article onto the site, and since 2026-09 it
// also does the two things a bare "POST to wp/v2/posts" left out:
//
//   images     Remote <img> sources and the featured image are downloaded and
//              uploaded to the site's media library (wp/v2/media), so the post
//              stops depending on our storage. wp/v2 has no way to tag an
//              attachment with where it came from, so a second publish of the
//              same article imports the images again; the plugin path
//              (wordpress-plugin.ts) records `_altorank_source_url` and does
//              not. Both are documented in packages/wordpress-plugin/README.
//
//   SEO meta   Sent as `meta` on the post. WordPress writes only meta keys the
//              installed plugins have registered with show_in_rest and silently
//              drops the rest, so this is safe to send blind. Rank Math
//              registers its keys; Yoast registers its keys; SEOPress and AIOSEO
//              do not, and for those two only the plugin path can write the
//              fields.

import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { WordPressConfig } from "@/lib/types";
import { seoPluginMeta } from "./wordpress-seo-meta";
import { fetchRemoteImage, remoteImageUrls } from "./remote-image";

export class WordPressAdapter implements CMSAdapter {
  private baseUrl: string;
  private auth: string;

  constructor(config: WordPressConfig) {
    this.baseUrl = config.siteUrl.replace(/\/+$/, "");
    this.auth = Buffer.from(`${config.username}:${config.applicationPassword}`).toString("base64");
  }

  private get host(): string {
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return "";
    }
  }

  private jsonHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Basic ${this.auth}`,
    };
  }

  /**
   * Upload one remote image to the media library. Returns the attachment's id
   * and its new URL on the site, or null when the image could not be fetched -
   * a broken image link is not worth failing the whole publish over, and the
   * original URL is left in place so the post still renders.
   */
  private async sideload(url: string): Promise<{ id: number; sourceUrl: string } | null> {
    try {
      const image = await fetchRemoteImage(url);
      const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/media`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.auth}`,
          "Content-Type": image.contentType,
          "Content-Disposition": `attachment; filename="${image.filename}"`,
        },
        body: new Uint8Array(image.bytes),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id: number; source_url: string };
      return { id: data.id, sourceUrl: data.source_url };
    } catch {
      return null;
    }
  }

  /** Rewrite remote image sources to media-library copies; returns the new HTML. */
  private async importInlineImages(html: string): Promise<string> {
    let out = html;
    for (const url of remoteImageUrls(html, this.host)) {
      const uploaded = await this.sideload(url);
      if (uploaded) out = out.split(url).join(uploaded.sourceUrl);
    }
    return out;
  }

  private async postBody(article: PublishPayload, status: "publish" | "draft") {
    const content = await this.importInlineImages(article.html);
    const featured = article.featuredImageUrl
      ? await this.sideload(article.featuredImageUrl)
      : null;

    return {
      title: article.title,
      content,
      slug: article.slug,
      status,
      excerpt: article.metaDescription ?? "",
      ...(article.tags?.length && { tags: article.tags }),
      ...(featured ? { featured_media: featured.id } : {}),
      meta: seoPluginMeta({
        title: article.title,
        metaDescription: article.metaDescription,
        focusKeyword: article.focusKeyword,
      }),
    };
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(await this.postBody(article, "publish")),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WordPress publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: String(data.id),
      url: data.link,
    };
  }

  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${externalId}`, {
      method: "PUT",
      headers: this.jsonHeaders(),
      body: JSON.stringify(await this.postBody(article, "publish")),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WordPress update failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return { externalId: String(data.id), url: data.link };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts/${externalId}`, {
      method: "PUT",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ status: "draft" }),
    });

    if (!res.ok) {
      throw new Error(`WordPress unpublish failed (${res.status})`);
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/wp-json/wp/v2/posts?per_page=1`, {
        headers: { Authorization: `Basic ${this.auth}` },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
