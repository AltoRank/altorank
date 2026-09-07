// ---------------------------------------------------------------------------
// Where the plugin comes from, and where it gets installed
// ---------------------------------------------------------------------------
//
// Two constants and a string join, split out of lib/cms/wordpress-plugin.ts
// because the connect dialog is a "use client" component and the adapter next
// to them talks to the database through the delivery log. A download link
// should not put the service role in the browser bundle: that is how #172
// first failed CI (lib/observability/__tests__/client-graph.test.ts is the
// guard). `wordpress-plugin.ts` re-exports all three.

/** The header the plugin authenticates with. Also read by the plugin itself. */
export const TOKEN_HEADER = "X-AltoRank-Token";

/**
 * Where the dialog sends the person to fetch the plugin: the app's own copy,
 * built from packages/wordpress-plugin by app/api/public/wordpress-plugin.
 * The plugin is not listed on wordpress.org, so a directory search for it
 * found nothing and the "Recommended" path ended there.
 */
export const PLUGIN_DOWNLOAD_PATH = "/api/public/wordpress-plugin";

/**
 * The Upload Plugin page inside the customer's own admin, which takes the
 * zip from PLUGIN_DOWNLOAD_PATH. Not the directory search tab: that only
 * finds plugins wordpress.org lists, and this one is not among them.
 */
export function pluginInstallUrl(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  return `${base}/wp-admin/plugin-install.php?tab=upload`;
}
