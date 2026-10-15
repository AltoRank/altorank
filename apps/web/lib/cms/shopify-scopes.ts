/**
 * The client-safe half of lib/cms/shopify.ts: what the connect dialog shows.
 * The adapter itself loads the server-side Supabase client for App Store
 * installations, so a client component must import from here, not there.
 */

/**
 * Every call the Shopify adapter makes reads or writes blogs and articles,
 * which Shopify files under the `content` scope pair. Nothing else is asked
 * for, and the connect dialog and the app's shopify.app.toml read this list
 * rather than restating it.
 * https://shopify.dev/docs/api/usage/access-scopes
 */
export const SHOPIFY_REQUIRED_SCOPES = ["read_content", "write_content"] as const;

export interface ShopifyBlog {
  id: string;
  title: string;
  handle: string;
}
