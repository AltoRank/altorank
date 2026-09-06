/**
 * Build-time SEO helpers shared by the layouts.
 *
 * Everything here runs in Node during `astro build` (the site is fully static),
 * so reading a file from public/ is fine and the output is baked into the HTML.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../public/', import.meta.url)));

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Pixel size of an image under public/, read from the file header rather than
 * assumed. Open Graph consumers (Slack, LinkedIn, iMessage) use
 * og:image:width/height to lay the card out before the image downloads, and a
 * wrong pair is worse than none, so this returns undefined for anything it
 * cannot read (remote URL, unknown format) instead of guessing 1200x630.
 */
export function imageDimensions(publicPath: string): ImageSize | undefined {
  if (!publicPath.startsWith('/')) return undefined;
  const file = resolve(PUBLIC_DIR, `.${publicPath}`);
  if (!existsSync(file)) return undefined;
  const buf = readFileSync(file);

  // PNG: 8-byte signature, then IHDR whose first two fields are width, height.
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segment list to the first SOFn frame header.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

/** Page language to the Open Graph locale tag it corresponds to. */
export function ogLocale(lang: string): string {
  const map: Record<string, string> = { en: 'en_US', it: 'it_IT', de: 'de_DE' };
  return map[lang] ?? 'en_US';
}

/**
 * Breadcrumb trail derived from the URL, for pages that do not author one.
 *
 * Only the hub pages (/about, /pricing, /blog, /tools, ...) reach this: every
 * templated page passes explicit breadcrumbs. Segment labels are title-cased
 * slugs and the last crumb is the page's own title, so the trail never claims
 * a label the page does not visibly carry.
 */
export function breadcrumbsFromPath(pathname: string, pageTitle: string): { label: string; href: string }[] {
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = [{ label: 'Home', href: '/' }];
  let href = '';
  segments.forEach((seg, i) => {
    href += `/${seg}`;
    const isLast = i === segments.length - 1;
    const label = isLast
      ? pageTitle
      : seg.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    crumbs.push({ label, href });
  });
  return crumbs;
}

export interface TaggedPost {
  id: string;
  data: { title: string; description: string; tags: string[]; publishDate: Date; dateModified?: Date; draft?: boolean };
}

/**
 * Posts related by shared tag, most overlap first, ties broken by recency.
 * Tag matching is exact and case-insensitive; there is no fallback to "latest
 * posts", so a post with no tag overlap gets no related block rather than an
 * unrelated one dressed up as a recommendation.
 */
export function relatedPosts<T extends TaggedPost>(all: T[], current: T, limit = 3): T[] {
  const mine = new Set(current.data.tags.map((t) => t.toLowerCase()));
  if (mine.size === 0) return [];
  return all
    .filter((p) => p.id !== current.id && !p.data.draft)
    .map((p) => ({ p, shared: p.data.tags.filter((t) => mine.has(t.toLowerCase())).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) =>
      b.shared - a.shared ||
      (b.p.data.dateModified ?? b.p.data.publishDate).valueOf() - (a.p.data.dateModified ?? a.p.data.publishDate).valueOf() ||
      a.p.id.localeCompare(b.p.id),
    )
    .slice(0, limit)
    .map((x) => x.p);
}
