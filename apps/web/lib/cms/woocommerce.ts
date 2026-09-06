import { WordPressAdapter } from "./wordpress";
import type { WooCommerceConfig } from "@/lib/types";

/**
 * WooCommerce stores are WordPress sites.
 *
 * The note beside this connector says "same as WordPress", and it used not to
 * be: this file held its own thinner copy of the WordPress adapter, sending
 * title, content, slug, status and excerpt and nothing else. So a WooCommerce
 * connection quietly lost the media-library import (every image kept pointing
 * at our storage) and the SEO plugin fields, and - because it had no update()
 * - every published WooCommerce article hit lib/publishing/core.ts's "cannot
 * be updated in place from here" on the second press of Publish.
 *
 * The endpoints are identical (wp-json/wp/v2/posts and /media with an
 * application password), so it extends the WordPress adapter and changes only
 * the name it fails under. The note is now true rather than aspirational.
 */
export class WooCommerceAdapter extends WordPressAdapter {
  protected readonly platform: string = "WooCommerce";

  constructor(config: WooCommerceConfig) {
    super({
      type: "wordpress",
      siteUrl: config.siteUrl,
      username: config.username,
      applicationPassword: config.applicationPassword,
    });
  }
}
