/**
 * The webhook topics the app subscribes to, in shopify.app.toml and here.
 *
 * The three privacy topics are mandatory for every App Store app; the app is
 * rejected without them. app/uninstalled is how we learn the tokens are dead.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */
export const SHOPIFY_COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export const SHOPIFY_EVENT_TOPICS = ["app/uninstalled"] as const;
export const SHOPIFY_WEBHOOK_TOPICS = [...SHOPIFY_COMPLIANCE_TOPICS, ...SHOPIFY_EVENT_TOPICS] as const;
export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];
