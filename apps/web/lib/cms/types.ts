/**
 * How a connection wants its posts to arrive on the CMS.
 *
 *   draft    created unpublished, for a person to release from the CMS itself
 *   publish  live the moment the adapter returns
 *
 * Chosen once, when the connection is made, and stored on the
 * workspace_integrations row; lib/cms/publish-mode.ts says which platforms can
 * express a draft and how.
 */
export type PublishMode = "publish" | "draft";

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
  /**
   * Omitted means "publish": every adapter went live unconditionally before
   * this field existed, and a payload built by older code must keep doing so.
   */
  publishMode?: PublishMode;
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
  /**
   * Replace an existing post in place, keeping its id and URL.
   *
   * Optional because not every platform's API has an edit path this adapter
   * implements yet. A caller that needs to update (the refresh engine) checks
   * for it and, when it is missing, says so instead of publishing a second
   * copy of the page: a duplicate post is worse than no push.
   */
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

/** Whether an adapter can edit a post it already published. */
export function canUpdate(adapter: CMSAdapter): adapter is CMSAdapter & Required<Pick<CMSAdapter, "update">> {
  return typeof adapter.update === "function";
}
