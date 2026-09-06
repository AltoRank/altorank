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
