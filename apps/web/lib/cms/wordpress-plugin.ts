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
  AdapterContext,
  CMSAdapter,
  CmsPostSummary,
  PublishPayload,
  PublishResult,
} from "./types";
import type { WordPressPluginConfig } from "@/lib/types";
import { deliverWithRetry } from "./delivery";
import { TOKEN_HEADER } from "./wordpress-plugin-install";

// The download path, the install URL and this header live in
// ./wordpress-plugin-install, which imports nothing: the connect dialog is a
// client component and this file reaches the database. Re-exported so every
// server-side caller keeps importing them from here.
export { TOKEN_HEADER, PLUGIN_DOWNLOAD_PATH, pluginInstallUrl } from "./wordpress-plugin-install";

/** Response shape shared by /submit and /edit. */
type PluginPostResponse = {
  id: number | string;
  url: string;
  slug?: string;
  status?: string;
  /** Where the site serves the IndexNow key, or null when it has none (plugin >= 1.1.1). */
  indexnow_key_location?: string | null;
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

export class WordPressPluginAdapter implements CMSAdapter {
  private baseUrl: string;
  private token: string;
  private onDelivery?: AdapterContext["onDelivery"];

  constructor(config: WordPressPluginConfig, context: AdapterContext = {}) {
    this.baseUrl = config.siteUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.onDelivery = context.onDelivery;
  }

  /**
   * One request with the shared retry loop (lib/cms/delivery.ts): a 5xx or a
   * network error is retried, the plugin's own 403/404 explanations are kept
   * as the final error.
   */
  private deliver(what: string, init: RequestInit & { path: string; query?: string }): Promise<Response> {
    const url = `${this.endpoint(init.path)}${init.query ? `?${init.query}` : ""}`;
    return deliverWithRetry({
      send: () => fetch(url, { method: init.method, headers: this.headers(), body: init.body }),
      what: `WordPress plugin ${what}`,
      endpoint: url,
      onDelivery: this.onDelivery,
      describe: async (res) => (await this.failure(res, what)).message,
      fail: (lastError) => new Error(lastError),
    });
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
      // When the article first went live (kept across republishes), which is
      // also the body's "Published" line and the BlogPosting's
      // datePublished. The plugin dates a post with it only when it creates
      // and publishes one; never the draft's creation time.
      published_at: article.publishedAt,
      // The plugin serves this at /{key}.txt (plugin >= 1.1.0), so the IndexNow
      // submission that follows the publish verifies without anyone placing a
      // file on the host. Older plugins ignore the field.
      indexnow_key: article.indexNowKey ?? undefined,
      // The dashboard's approval gate has already passed by the time this runs.
      // The connection's publish mode decides draft or live; the plugin's own
      // "post as draft" setting may still hold it, and says so in the response.
      status: article.publishMode === "draft" ? "draft" : "publish",
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

  private async toResult(data: PluginPostResponse, article: PublishPayload): Promise<PublishResult> {
    const status = data.status === "draft" ? "draft" : "publish";
    const result: PublishResult = { externalId: String(data.id), url: data.url, status };
    // Only a live post is submitted to IndexNow, so only then is the location needed.
    const keyLocation = status === "publish" ? await this.indexNowKeyLocation(data, article) : undefined;
    if (keyLocation) result.indexNowKeyLocation = keyLocation;
    return result;
  }

  /**
   * Where the site serves the IndexNow key this publish carried. The host
   * root is wrong for a WordPress in a subdirectory, and the plugin knows its
   * own home URL: 1.1.1 says so in the post response, 1.1.0 only through GET
   * /indexnow. Best effort: no answer means the indexing step uses the root.
   */
  private async indexNowKeyLocation(data: PluginPostResponse, article: PublishPayload): Promise<string | undefined> {
    if (!article.indexNowKey) return undefined;
    if (typeof data.indexnow_key_location === "string") return data.indexnow_key_location;
    if ("indexnow_key_location" in data) return undefined;
    try {
      const res = await fetch(this.endpoint("indexnow"), { headers: this.headers() });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { key?: unknown; key_location?: unknown };
      return body.key === article.indexNowKey && typeof body.key_location === "string" ? body.key_location : undefined;
    } catch {
      return undefined;
    }
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await this.deliver("publish", { path: "submit", method: "POST", body: JSON.stringify(this.body(article)) });
    return this.toResult((await res.json()) as PluginPostResponse, article);
  }

  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const res = await this.deliver("update", {
      path: "edit",
      method: "PUT",
      // An update edits content; the post keeps whatever state it has on the site.
      // The post is named by its WordPress id; the article id rides along
      // only when known, so the plugin can fall back to it. A post id is never
      // sent as an external id: the plugin matches that against the id it
      // recorded at submit.
      // No date either: an edit keeps the post's date, including one an editor
      // corrected on the site.
      body: JSON.stringify({ ...this.body(article), status: undefined, published_at: undefined, post_id: externalId }),
    });
    return this.toResult((await res.json()) as PluginPostResponse, article);
  }

  /** Back to draft, the same as the REST adapter: nothing is deleted. */
  async unpublish(externalId: string): Promise<void> {
    await this.deliver("unpublish", { path: "edit", method: "PUT", body: JSON.stringify({ post_id: externalId, status: "draft" }) });
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
