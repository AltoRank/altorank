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
  title: string;
  html: string;
  slug: string;
  metaDescription?: string;
  tags?: string[];
  publishedAt?: string;
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
}

export interface CMSAdapter {
  publish(article: PublishPayload): Promise<PublishResult>;
  unpublish(externalId: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
