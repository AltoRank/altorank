export interface PublishPayload {
  title: string;
  html: string;
  slug: string;
  metaDescription?: string;
  tags?: string[];
  publishedAt?: string;
  featuredImageUrl?: string;
}

export interface PublishResult {
  externalId: string;
  url: string;
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
}

/** Whether an adapter can edit a post it already published. */
export function canUpdate(adapter: CMSAdapter): adapter is CMSAdapter & Required<Pick<CMSAdapter, "update">> {
  return typeof adapter.update === "function";
}
