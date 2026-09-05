// ---------------------------------------------------------------------------
// BlogClient: read your published articles from AltoRank
// ---------------------------------------------------------------------------
//
// Server-side only. The API key is a credential and must not reach the
// browser: call this from Server Components, route handlers, or generateStatic
// Params, never from a "use client" file.
//
// Talks to two routes on the dashboard:
//
//   GET /api/blog/v1/articles?workspace_id=&page=&per_page=
//   GET /api/blog/v1/articles/<slug>?workspace_id=
//
// Both return only articles with status "live": approved in the dashboard and
// published. Drafts and articles awaiting review never come through here.

export type BlogArticleSummary = {
  id: string;
  slug: string;
  title: string;
  meta_description: string | null;
  featured_image_url: string | null;
  keyword: string | null;
  word_count: number;
  published_url: string | null;
  published_at: string | null;
  updated_at: string;
};

export type BlogArticle = BlogArticleSummary & {
  /** The body as HTML, the same rendering the dashboard publishes to a CMS. */
  content_html: string;
};

export type BlogArticleList = {
  articles: BlogArticleSummary[];
  page: number;
  per_page: number;
  total: number;
};

export type BlogClientOptions = {
  /** Defaults to process.env.ALTORANK_BLOG_API_KEY. */
  apiKey?: string;
  /** The site's workspace id in the dashboard. Defaults to process.env.ALTORANK_WORKSPACE_ID. */
  workspaceId?: string;
  /** Dashboard origin. Defaults to process.env.ALTORANK_API_URL, then https://app.altorank.co. */
  baseUrl?: string;
  /**
   * ISR window in seconds, forwarded as Next's `next.revalidate` fetch option.
   * Default one day. Pass 0 to fetch fresh on every request.
   */
  revalidate?: number;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
};

export class BlogClientError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "BlogClientError";
  }
}

export class BlogClient {
  private apiKey: string;
  private workspaceId: string;
  private baseUrl: string;
  private revalidate: number;
  private fetchImpl: typeof fetch;

  constructor(options: BlogClientOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
    this.apiKey = options.apiKey ?? env.ALTORANK_BLOG_API_KEY ?? "";
    this.workspaceId = options.workspaceId ?? env.ALTORANK_WORKSPACE_ID ?? "";
    this.baseUrl = (options.baseUrl ?? env.ALTORANK_API_URL ?? "https://app.altorank.co").replace(/\/+$/, "");
    this.revalidate = options.revalidate ?? 86400;
    this.fetchImpl = options.fetch ?? fetch;

    if (!this.apiKey) throw new Error("BlogClient: apiKey is required (or set ALTORANK_BLOG_API_KEY)");
    if (!this.workspaceId) throw new Error("BlogClient: workspaceId is required (or set ALTORANK_WORKSPACE_ID)");
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
    const url = new URL(`${this.baseUrl}/api/blog/v1/${path}`);
    url.searchParams.set("workspace_id", this.workspaceId);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const init: RequestInit & { next?: { revalidate: number } } = {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      next: { revalidate: this.revalidate },
    };

    const res = await this.fetchImpl(url.toString(), init);
    if (res.status === 404) return null;
    if (!res.ok) {
      let message = `AltoRank blog API returned ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = `${message}: ${body.error}`;
      } catch {
        // no JSON body
      }
      throw new BlogClientError(res.status, message);
    }
    return (await res.json()) as T;
  }

  /** One page of live articles, newest first. */
  async list(opts: { page?: number; perPage?: number } = {}): Promise<BlogArticleList> {
    const result = await this.request<BlogArticleList>("articles", {
      page: String(opts.page ?? 1),
      per_page: String(opts.perPage ?? 20),
    });
    return result ?? { articles: [], page: opts.page ?? 1, per_page: opts.perPage ?? 20, total: 0 };
  }

  /** Every live article, walking the pages. For generateStaticParams. */
  async listAll(): Promise<BlogArticleSummary[]> {
    const all: BlogArticleSummary[] = [];
    for (let page = 1; ; page++) {
      const { articles, total } = await this.list({ page, perPage: 100 });
      all.push(...articles);
      if (articles.length === 0 || all.length >= total) break;
    }
    return all;
  }

  /** One article with its HTML body, or null when no live article has that slug. */
  async get(slug: string): Promise<BlogArticle | null> {
    const result = await this.request<{ article: BlogArticle }>(`articles/${encodeURIComponent(slug)}`);
    return result?.article ?? null;
  }
}
