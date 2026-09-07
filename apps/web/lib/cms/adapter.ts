import type { AdapterContext, CMSAdapter } from "./types";
import type { CMSConfig } from "@/lib/types";
import { WordPressAdapter } from "./wordpress";
import { WordPressPluginAdapter } from "./wordpress-plugin";
import { ShopifyAdapter } from "./shopify";
import { MagentoAdapter } from "./magento";
import { WebflowAdapter } from "./webflow";
import { GhostAdapter } from "./ghost";
import { FramerAdapter } from "./framer";
import { WixAdapter } from "./wix";
import { NotionAdapter } from "./notion";
import { HubSpotAdapter } from "./hubspot";
import { WooCommerceAdapter } from "./woocommerce";
import { WebhookAdapter } from "./webhook";
import { GitAdapter } from "./git";

/**
 * Every adapter, by the `type` stored in its connection config.
 *
 * Exists so a caller can ask what an adapter *can do* without a decrypted
 * config to construct one with. A server component rendering the refresh
 * review screen has the connection's type and nothing else, and the question
 * it needs answered - "can this CMS be edited in place?" - is a property of
 * the class, not of the instance.
 *
 * `adapter-capabilities.test.ts` fails if this drifts from the switch below.
 */
const ADAPTER_CLASSES: Record<string, { prototype: Partial<CMSAdapter> }> = {
  wordpress: WordPressAdapter,
  "wordpress-plugin": WordPressPluginAdapter,
  shopify: ShopifyAdapter,
  magento: MagentoAdapter,
  webflow: WebflowAdapter,
  ghost: GhostAdapter,
  framer: FramerAdapter,
  wix: WixAdapter,
  notion: NotionAdapter,
  hubspot: HubSpotAdapter,
  woocommerce: WooCommerceAdapter,
  webhook: WebhookAdapter,
  git: GitAdapter,
};

/**
 * The CMS types whose adapter can edit a post in place.
 *
 * Derived, because the hand-written copy of this went stale and the product
 * lost a feature by it. `lib/refresh/push.ts` used to carry the list as a
 * literal of five - wordpress, ghost, webflow, webhook, git - while eleven
 * adapters implemented `update`. The refresh screens read that literal to
 * decide whether to offer "Push to site", so a Shopify, HubSpot, Magento,
 * Framer, WordPress-plugin or WooCommerce customer was told their connection
 * "can publish new posts but cannot yet edit an existing one" and sent away
 * to copy HTML by hand - while `pushExecution`'s own `canUpdate(adapter)`
 * check, which asks the instance rather than the list, would have pushed it.
 * The whole refresh loop was switched off for six of thirteen CMSs by a
 * stale Set. Only Notion and Wix genuinely cannot, which is what
 * publishArticleCore already says when it refuses a republish.
 *
 * A capability the runtime tests on the instance must not be restated by
 * hand anywhere else.
 */
export const UPDATABLE_CMS_TYPES: ReadonlySet<string> = new Set(
  Object.entries(ADAPTER_CLASSES)
    .filter(([, cls]) => typeof cls.prototype.update === "function")
    .map(([type]) => type),
);

/**
 * `context` carries what an adapter may report back while it works - the
 * per-attempt delivery hook of the adapters that retry over HTTP (webhook,
 * WordPress plugin). Optional, because most callers
 * (connection tests, unpublish) have nowhere to put it.
 */
export function resolveCMSAdapter(config: CMSConfig, context: AdapterContext = {}): CMSAdapter {
  switch (config.type) {
    case "wordpress":
      return new WordPressAdapter(config);
    case "wordpress-plugin":
      return new WordPressPluginAdapter(config, context);
    case "shopify":
      return new ShopifyAdapter(config);
    case "magento":
      return new MagentoAdapter(config);
    case "webflow":
      return new WebflowAdapter(config);
    case "ghost":
      return new GhostAdapter(config);
    case "framer":
      return new FramerAdapter(config);
    case "wix":
      return new WixAdapter(config);
    case "notion":
      return new NotionAdapter(config);
    case "hubspot":
      return new HubSpotAdapter(config);
    case "woocommerce":
      return new WooCommerceAdapter(config);
    case "git":
      return new GitAdapter(config);
    case "webhook":
      return new WebhookAdapter(config, context);
    default:
      throw new Error(`Unsupported CMS type: ${(config as { type: string }).type}`);
  }
}
