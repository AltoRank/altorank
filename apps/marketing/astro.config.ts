import { defineConfig } from 'astro/config';
import { readdirSync, readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

// Read a frontmatter date field (YYYY-MM-DD) from a raw markdown string.
function frontmatterDate(raw: string, field: string): string | undefined {
  return raw.match(new RegExp(`^${field}:\\s*["']?(\\d{4}-\\d{2}-\\d{2})`, 'm'))?.[1];
}

// Build-time scan of the content collections. Two outputs:
//  1. publishedToolSlugs: which /tools/* pages are indexable. A tool opts in via
//     `published: true` (also drives noindex in [slug].astro), so the sitemap and
//     the per-page robots meta stay in agreement: drafts are noindex'd AND out of
//     the sitemap; published tools are in both.
//  2. lastmodByPath: real per-URL <lastmod> dates sourced from content, NOT the
//     build time. A build-time lastmod would reset the freshness signal on every
//     deploy, which is the kind of unearned signal the site's hard rules forbid.
const publishedToolSlugs = new Set<string>();
const lastmodByPath = new Map<string, string>();

function scanCollection(dir: string, urlPrefix: string, dateFields: string[]) {
  const base = new URL(`./src/content/${dir}/`, import.meta.url);
  for (const file of readdirSync(base).filter((f) => /\.mdx?$/.test(f))) {
    const raw = readFileSync(new URL(file, base), 'utf-8');
    const slug = raw.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim()
      ?? file.replace(/\.mdx?$/, '');
    if (dir === 'tools' && /^published:\s*true\s*$/m.test(raw)) publishedToolSlugs.add(slug);
    for (const field of dateFields) {
      const date = frontmatterDate(raw, field);
      if (date) { lastmodByPath.set(`${urlPrefix}/${slug}`, date); break; }
    }
  }
}

scanCollection('tools', '/tools', ['dateModified', 'datePublished']);
scanCollection('blog', '/blog', ['dateModified', 'publishDate']);

// Pages that set noindex={true}. /success-stories, /for and /integrations are
// thin hubs (269, 327 and 254 rendered words) kept for navigation but out of the
// index; /privacy and /terms are noindex until finalised.
const NOINDEX_ROUTES = ['privacy', 'terms', 'success-stories', 'for'];

export default defineConfig({
  site: 'https://altorank.co',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    sitemap({
      filter: (page) => {
        if (page.includes('/404')) return false;
        // Routes that set noindex in their page/layout props. Listing a noindex
        // URL in the sitemap asks Google to crawl something we then tell it to
        // drop, so the sitemap and the robots meta must say the same thing.
        // Keep this in sync when adding or removing a noindex page.
        if (NOINDEX_ROUTES.some((r) => new RegExp(`/${r}/?$`).test(page))) return false;
        // Individual tool page: include only if its slug is published.
        const toolSlug = page.match(/\/tools\/([^/]+)\/?$/)?.[1];
        if (toolSlug) return publishedToolSlugs.has(toolSlug);
        // Tools index: keep out until it lists a real directory of guides (>= 3),
        // so we never ship a thin one-item hub. Must match TOOLS_HUB_MIN in
        // src/pages/tools/index.astro.
        if (/\/tools\/?$/.test(page)) return publishedToolSlugs.size >= 3;
        return true;
      },
      serialize: (item) => {
        // Attach a real content date as <lastmod> where we have one.
        const path = new URL(item.url).pathname.replace(/\/$/, '');
        const date = lastmodByPath.get(path);
        if (date) item.lastmod = new Date(`${date}T00:00:00Z`).toISOString();
        return item;
      },
    }),
    mdx(),
  ],
});
