// ---------------------------------------------------------------------------
// Limits before effort: one paragraph per connector, shown at the top of its
// form before the person goes looking for a token.
// ---------------------------------------------------------------------------
//
// Every sentence here is either read off the vendor's own documentation (the
// link is the source) or off our adapter's code. Nothing is inferred from
// competitor copy. When a limit cannot be sourced it is not stated: an
// unsourced warning trains people to ignore the sourced ones.

import type { CMSConfig } from "@/lib/types";
import { SHOPIFY_REQUIRED_SCOPES } from "./shopify";
import { MAX_ATTEMPTS } from "./delivery";

export interface ConnectorNote {
  text: string;
  /** The vendor page the claim is read from. Absent when the source is our code. */
  docUrl?: string;
  docLabel?: string;
}

/**
 * Present for every type: a connector missing from here has no paragraph,
 * and TypeScript says so before a person finds out at the form.
 */
export const CONNECTOR_NOTES: Record<CMSConfig["type"], ConnectorNote> = {
  "wordpress-plugin": {
    text:
      "Recommended. No WordPress login is shared: the plugin holds one token for this site. Images are imported into the media library and Rank Math, Yoast, SEOPress and AIOSEO fields are filled in. Posts arrive as drafts unless you change that in the plugin.",
  },
  wordpress: {
    text:
      "Uses a WordPress application password over the REST API. WordPress only offers application passwords on sites served over HTTPS, and the account needs to be able to publish posts. Works without a plugin; SEOPress and AIOSEO fields cannot be written this way.",
    docUrl: "https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/",
    docLabel: "WordPress: application passwords",
  },
  shopify: {
    text: `You must be the store owner, or staff with the "App development" permission; collaborator accounts cannot create custom apps. The store needs at least one blog, or there is nowhere to publish. The app needs only ${SHOPIFY_REQUIRED_SCOPES.join(" and ")}. Custom apps created in Shopify's Dev Dashboard (all new ones since 1 January 2026) do not show an Admin API token in the admin; they issue 24-hour tokens through a client-credentials exchange, which this connector does not perform yet. Legacy custom apps show their token once.`,
    docUrl: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
    docLabel: "Shopify: custom apps",
  },
  magento: {
    text: "Creates static CMS pages on your storefront (e.g. /your-slug), not blog posts. Needs an admin token for the REST API.",
  },
  webflow: {
    text:
      "Collections exist only on a site plan that includes CMS items: Webflow's Basic site plan has none and no content-management API, so there is nothing to connect to. The API token needs the sites:read, cms:read and cms:write scopes. Articles are written to one collection, into the fields you choose below.",
    docUrl: "https://webflow.com/pricing",
    docLabel: "Webflow: site plans",
  },
  ghost: {
    text:
      "Needs the Admin API key of a custom integration (Settings → Integrations), in id:secret form. Ghost(Pro)'s Starter plan does not include custom integrations or the Admin API; Publisher and above do. Self-hosted Ghost has no such restriction.",
    docUrl: "https://ghost.org/pricing/",
    docLabel: "Ghost: plan comparison",
  },
  framer: {
    text:
      "Framer's Server API is a script SDK bound to one project, generated under Site Settings → General; there is no endpoint we can call to list your projects or collections, so the ids are pasted. This connector has not been exercised against a live Framer project: use Send test before relying on it.",
    docUrl: "https://www.framer.com/developers/server-api-reference",
    docLabel: "Framer: Server API",
  },
  wix: {
    text:
      "API keys are created in the account's API Keys Manager and scoped to all sites or chosen ones; the account id is on the same page. The key needs the Manage Blog permission to write posts, and Read Site Data to list your sites here. Posts are created as drafts and, for a live connection, published in a second call.",
    docUrl: "https://dev.wix.com/docs/go-headless/authentication/admin/generate-an-api-key",
    docLabel: "Wix: generate an API key",
  },
  notion: {
    text:
      "Pages in a Notion database have no draft or published state of their own. A draft connection needs a Status-type property on the database, named below; without one only live publishing is offered. The integration token must have access to that database.",
  },
  hubspot: {
    text:
      "Uses a private-app access token. If no blog id is given, the first blog found on an existing post is used; a portal with no posts yet must set the blog id by hand.",
  },
  woocommerce: {
    text: "Uses the WordPress REST API — same as WordPress but for WooCommerce stores. The same HTTPS rule for application passwords applies.",
    docUrl: "https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/",
    docLabel: "WordPress: application passwords",
  },
  webhook: {
    text: `POST article data to any URL, optionally signed with HMAC-SHA256. Network failures and 5xx answers are retried, ${MAX_ATTEMPTS} attempts in all; a 4xx is taken as final. Your endpoint decides what publish_mode means.`,
  },
  git: {
    text:
      "For sites built from a repository (Astro, Next, Hugo, Jekyll, Eleventy). Articles are committed as Markdown; your host builds and deploys them. The token needs contents:write on that repository.",
  },
};
