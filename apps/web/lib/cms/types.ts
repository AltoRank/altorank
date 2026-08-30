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
}
