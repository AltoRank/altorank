// ---------------------------------------------------------------------------
// WordPress through the AltoRank plugin
// ---------------------------------------------------------------------------
//
// The application-password adapter (wordpress.ts) can only do what wp/v2
// exposes: it cannot import images into the media library and tag them so a
// refresh does not import them again, cannot write SEOPress or AIOSEO fields
// (neither registers its meta for REST), and needs a WordPress user account
// whose password we hold.
//
// The plugin (packages/wordpress-plugin) puts one REST namespace on the site,
// altorank/v1, guarded by a per-site token that only ever travels in a header.
// Everything WordPress-specific - sanitising, sideloading, slug de-duplication,
// SEO plugin meta - happens in PHP, where the WordPress functions for it live.
// This adapter is the thin client.
//
// The token is generated in the connect dialog, shown once, and stored
// encrypted in workspace_integrations.config. It never appears in a URL or a
// log line; the plugin compares it with hash_equals.

import type {
  CMSAdapter,
  CmsPostSummary,
  PublishPayload,
  PublishResult,
} from "./types";
import type { WordPressPluginConfig } from "@/lib/types";

export const TOKEN_HEADER = "X-AltoRank-Token";

/** Response shape shared by /submit and /edit. */
type PluginPostResponse = {
  id: number | string;
  url: string;
  slug?: string;
  status?: string;
};

type PluginListResponse = {
  posts: Array<{
    id: number | string;
    title: string;
    slug: string;
    url: string;
    status: string;
    modified?: string;
  }>;
};

/** Install page for the plugin inside the customer's own admin. */
export function pluginInstallUrl(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  return `${base}/wp-admin/plugin-install.php?s=altorank&tab=search&type=term`;
}

export class WordPressPluginAdapter implements CMSAdapter {
  private baseUrl: string;
  private token: string;

  constructor(config: WordPressPluginConfig) {
    this.baseUrl = config.siteUrl.replace(/\/+$/, "");
    this.token = config.token;
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/wp-json/altorank/v1/${path.replace(/^\/+/, "")}`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      [TOKEN_HEADER]: this.token,
    };
  }

  /** The field names the plugin's /submit and /edit handlers read. */
  private body(article: PublishPayload) {
    return {
      id: article.id,
      external_id: article.id,
      title: article.title,
      content: article.html,
      slug: article.slug,
      meta_description: article.metaDescription,
      focus_keyword: article.focusKeyword,
      featured_image_url: article.featuredImageUrl,
      tags: article.tags ?? [],
      created_at: article.createdAt,
      // The dashboard's approval gate has already passed by the time this runs.
      // The plugin's own "post as draft" setting may still hold it, and says so
      // in the response.
      status: "publish",
    };
  }

  private async failure(res: Response, what: string): Promise<Error> {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const json = JSON.parse(text) as { message?: string };
      if (json.message) detail = json.message;
    } catch {
      // plain text is fine
    }
    if (res.status === 403) {
      return new Error(
        `WordPress plugin ${what} rejected (403): the integration token does not match the one saved in Settings -> AltoRank`,
      );
    }
    if (res.status === 404) {
      return new Error(
        `WordPress plugin ${what} failed (404): the AltoRank plugin is not installed or not activated on this site`,
      );
    }
    return new Error(`WordPress plugin ${what} failed (${res.status}): ${detail}`);
  }

  private toResult(data: PluginPostResponse): PublishResult {
    return {
      externalId: String(data.id),
      url: data.url,
      status: data.status === "draft" ? "draft" : "publish",
    };
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(this.endpoint("submit"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.body(article)),
    });
    if (!res.ok) throw await this.failure(res, "publish");
    return this.toResult((await res.json()) as PluginPostResponse);
  }

  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(this.endpoint("edit"), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ ...this.body(article), post_id: externalId, external_id: article.id ?? externalId }),
    });
    if (!res.ok) throw await this.failure(res, "update");
    return this.toResult((await res.json()) as PluginPostResponse);
  }

  /** Back to draft, the same as the REST adapter: nothing is deleted. */
  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(this.endpoint("edit"), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ post_id: externalId, status: "draft" }),
    });
    if (!res.ok) throw await this.failure(res, "unpublish");
  }

  async listPosts(opts: { page?: number; perPage?: number; status?: string } = {}): Promise<CmsPostSummary[]> {
    const params = new URLSearchParams({
      page: String(opts.page ?? 1),
      per_page: String(opts.perPage ?? 50),
      status: opts.status ?? "publish",
    });
    const res = await fetch(`${this.endpoint("posts")}?${params}`, { headers: this.headers() });
    if (!res.ok) throw await this.failure(res, "list");
    const data = (await res.json()) as PluginListResponse;
    return (data.posts ?? []).map((p) => ({
      externalId: String(p.id),
      title: p.title,
      slug: p.slug,
      url: p.url,
      status: p.status,
      modifiedAt: p.modified,
    }));
  }

  /**
   * Round trip through the plugin: it creates a draft named
   * altorank-test-post-<timestamp> and deletes it again, which proves the token
   * matches, the REST route is reachable and the site can write posts. Nothing
   * is left behind.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(this.endpoint("test-integration"), {
        method: "POST",
        headers: this.headers(),
        body: "{}",
      });
      if (!res.ok) return { ok: false, error: (await this.failure(res, "test")).message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
