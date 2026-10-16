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

/**
 * What the App Store app asks for: publishing needs only the content pair
 * above (a merchant's own custom app is told exactly that), and the app adds
 * read_products so a store whose storefront is behind its password page can
 * still be learned from - product copy is most stores' real content
 * (lib/shopify/store-content.ts). shopify/shopify.app.toml must match.
 */
export const SHOPIFY_APP_SCOPES = [...SHOPIFY_REQUIRED_SCOPES, "read_products"] as const;

export interface ShopifyBlog {
  id: string;
  title: string;
  handle: string;
}
