// The site's own sitemap and blog root, from onboarding, are the first two
// link sources. `ensureDefaultSources` (lib/linking/detect.ts) writes them
// back on every /linking render and every detection run, so deleting one
// never stuck: it came straight back. Disabling is what sticks, so these rows
// offer only the switch. A sitemap or blog root added by hand at another URL
// is not a default and can be removed.

export interface DefaultSourceUrls {
  sitemap_url?: string | null;
  blog_root_url?: string | null;
}

/** Whether this source is one the page re-creates, and so can be switched off but not removed. */
export function isDefaultSource(source: { url: string }, ws: DefaultSourceUrls | null | undefined): boolean {
  if (!ws) return false;
  return source.url === ws.sitemap_url || source.url === ws.blog_root_url;
}

export const DEFAULT_SOURCE_NOTE = "This is your site's own sitemap or blog root, so it is kept. Switch it off to stop reading it.";
