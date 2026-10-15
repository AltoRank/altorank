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
 * The oldest plugin the connection test accepts. Raised when installs older
 * than it must not be connected; never above the version this app serves at
 * PLUGIN_DOWNLOAD_PATH (wordpress-plugin-release.test.ts holds that).
 */
export const MIN_PLUGIN_VERSION = "1.1.1";

/** -1, 0 or 1 for dotted numeric versions ("1.10.0" > "1.9.2"); anything non-numeric counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

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
