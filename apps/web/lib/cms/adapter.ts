import type { CMSAdapter } from "./types";
import type { CMSConfig } from "@/lib/types";
import { WordPressAdapter } from "./wordpress";
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

export function resolveCMSAdapter(config: CMSConfig): CMSAdapter {
  switch (config.type) {
    case "wordpress":
      return new WordPressAdapter(config);
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
      return new WebhookAdapter(config);
    default:
      throw new Error(`Unsupported CMS type: ${(config as { type: string }).type}`);
  }
}
