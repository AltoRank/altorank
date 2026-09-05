export interface PublishPayload {
  /**
   * Our article id. Adapters that keep a record on the far side (the
   * WordPress plugin, a webhook consumer) store it as the external reference,
   * so a refresh finds the same post instead of creating a second one.
   */
  id?: string;
  title: string;
  html: string;
  /** The same body as Markdown, for consumers that prefer it (webhooks). */
  markdown?: string;
  slug: string;
  metaDescription?: string;
  /** The keyword the article targets; written to the SEO plugin's focus field. */
  focusKeyword?: string;
  tags?: string[];
  publishedAt?: string;
  /** When the draft was written, as ISO 8601. */
  createdAt?: string;
  featuredImageUrl?: string;
}

export interface PublishResult {
  externalId: string;
  url: string;
  /**
   * What the far side did with the post. Only set by adapters whose target can
   * decide to hold it - the WordPress plugin's "post as draft" setting - so the
   * publish core knows not to tell search engines about a URL that only an
   * editor can open.
   */
  status?: "draft" | "publish";
}

/** One existing post on the far side, for refreshes and internal-link discovery. */
export interface CmsPostSummary {
  externalId: string;
  title: string;
  slug: string;
  url: string;
  status: string;
  modifiedAt?: string;
}

export interface CMSAdapter {
  publish(article: PublishPayload): Promise<PublishResult>;
  unpublish(externalId: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  /** Replace an existing post in place. Optional: most CMS APIs make this a second publish. */
  update?(externalId: string, article: PublishPayload): Promise<PublishResult>;
  /** Read the site's existing posts. Optional: only adapters with a list endpoint. */
  listPosts?(opts?: { page?: number; perPage?: number; status?: string }): Promise<CmsPostSummary[]>;
}

/**
 * One delivery attempt, reported by adapters that retry (the webhook). The
 * publish core turns each one into a publish_log row, so a customer's endpoint
 * that failed twice and then took the article shows all three tries.
 */
export interface DeliveryAttempt {
  attempt: number;
  maxAttempts: number;
  ok: boolean;
  /** HTTP status when a response came back; absent on a network failure. */
  status?: number;
  error?: string;
}

export interface AdapterContext {
  onDelivery?: (attempt: DeliveryAttempt) => Promise<void> | void;
}
