#!/usr/bin/env node
// Technical SEO audit of the built site.
//
// Reads dist/ (the real deploy artefact, not the dev server) and prints a
// pass/fail table per check, then the failing pages. No network, no browser,
// no dependencies: a regex pass over static HTML is enough for the checks
// below and keeps this runnable in CI in under a second.
//
//   npm run build && node scripts/audit-dist.mjs            table + failures
//   node scripts/audit-dist.mjs --json > audit.json          machine-readable
//   node scripts/audit-dist.mjs --verbose                    every failure, not just the first 20
//
// Exit code is 1 when any hard check fails, so it can gate a deploy.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SITE = 'https://altorank.co';
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const VERBOSE = args.has('--verbose');

if (!existsSync(DIST)) {
  console.error('dist/ not found; run `npx astro build` first');
  process.exit(2);
}

// ── Pixel widths ─────────────────────────────────────────────────────────────
// Google truncates titles by rendered width, not characters: ~600px at 18px
// Arial for titles, ~960px at 13.5px for descriptions (desktop). Arial/Helvetica
// advance widths in 1/1000 em, from the standard AFM metrics; anything not in
// the table (accents, dashes, non-Latin) is assumed to be a wide glyph.
const ARIAL = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
  '–': 556, '—': 1000, '’': 222, '“': 333, '”': 333, '·': 278,
};
const px = (text, size) =>
  Math.round([...text].reduce((w, ch) => w + (ARIAL[ch] ?? 667), 0) / 1000 * size);

const TITLE_MAX_PX = 600;
const TITLE_PX_SIZE = 18;
const DESC_MAX_PX = 960;
const DESC_PX_SIZE = 13.5;

// ── Helpers ──────────────────────────────────────────────────────────────────
const decode = (s) =>
  s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === 'index.html') out.push(p);
  }
  return out;
}

/** dist/foo/bar/index.html -> /foo/bar/ ; dist/index.html -> / */
const routeOf = (file) => {
  const rel = file.slice(DIST.length).replace(/\\/g, '/').replace(/index\.html$/, '');
  return rel === '' ? '/' : rel;
};

const meta = (html, attr, name) => {
  const re = new RegExp(`<meta\\s+[^>]*?${attr}=["']${name}["'][^>]*?>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return undefined;
  return decode(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '');
};

const attrOf = (tag, name) => tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, 'i'))?.[1];

/** Everything inside <head>, minus inline JSON-LD (which is not markup). */
const headOf = (html) => html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';

/** Body text with scripts/styles removed, for the H1 and image checks. */
const bodyOf = (html) =>
  (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

/** Does an internal path resolve to a file in dist? */
function resolvesInDist(path) {
  const clean = path.replace(/[?#].*$/, '');
  if (clean === '' || clean === '/') return existsSync(join(DIST, 'index.html'));
  const rel = clean.replace(/^\//, '').replace(/\/$/, '');
  return (
    existsSync(join(DIST, rel, 'index.html')) ||
    existsSync(join(DIST, rel)) ||
    existsSync(join(DIST, `${rel}.html`))
  );
}

/** Cloudflare Pages _redirects, so a redirected link is reported as such, not a 404. */
const redirects = (() => {
  const file = join(DIST, '_redirects');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([from, to]) => ({ from, to, re: new RegExp('^' + from.replace(/\*/g, '.*').replace(/\//g, '\\/') + '\\/?$') }));
})();
const redirectFor = (path) => redirects.find((r) => r.re.test(path.replace(/[?#].*$/, '')));

// Content-collection frontmatter, read from source: the one thing dist cannot
// tell us is whether a `faq` array existed for a page, and the FAQPage check
// needs to know that to be a "must", not a "nice to have".
function collectionFaq(dir, urlPrefix) {
  const base = join(ROOT, 'src', 'content', dir);
  const out = new Map();
  if (!existsSync(base)) return out;
  for (const f of readdirSync(base).filter((f) => /\.mdx?$/.test(f))) {
    const raw = readFileSync(join(base, f), 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const slug = fm.match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim() ?? f.replace(/\.mdx?$/, '');
    const hasFaq = /^faq:\s*$/m.test(fm) && /^\s+-\s+question:/m.test(fm);
    out.set(`${urlPrefix}/${slug}/`, hasFaq);
  }
  return out;
}
const faqByRoute = new Map([...collectionFaq('blog', '/blog'), ...collectionFaq('tools', '/tools')]);
const BLOG_RE = /^\/blog\/[^/]+\/$/;
// Pages that describe the product itself and should carry SoftwareApplication.
const PRODUCT_ROUTES = new Set(['/', '/pricing/', '/open-source/']);

// ── Sitemap ──────────────────────────────────────────────────────────────────
function sitemapRoutes() {
  const index = join(DIST, 'sitemap-index.xml');
  if (!existsSync(index)) return null;
  const subs = [...readFileSync(index, 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  const urls = new Set();
  for (const sub of subs) {
    const file = join(DIST, new URL(sub).pathname);
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)) {
      let p = new URL(m[1]).pathname;
      if (!p.endsWith('/')) p += '/';
      urls.add(p);
    }
  }
  return urls;
}
const sitemap = sitemapRoutes();

// ── Checks ───────────────────────────────────────────────────────────────────
// Every check returns null (pass) or a string (why it failed). `soft` checks
// count as warnings and do not affect the exit code.
const CHECKS = [];
const check = (id, label, fn, opts = {}) => CHECKS.push({ id, label, fn, soft: Boolean(opts.soft), only: opts.only });

check('title', 'title present and <= 600px @18px Arial', ({ title }) => {
  if (!title) return 'missing <title>';
  const w = px(title, TITLE_PX_SIZE);
  return w > TITLE_MAX_PX ? `${w}px: "${title}"` : null;
});

check('description', 'description present and <= 960px @13.5px', ({ description }) => {
  if (!description) return 'missing meta description';
  const w = px(description, DESC_PX_SIZE);
  return w > DESC_MAX_PX ? `${w}px (${description.length} chars)` : null;
});

check('canonical', 'canonical is absolute and matches the route', ({ canonical, route }) => {
  if (!canonical) return 'missing canonical';
  if (!/^https?:\/\//.test(canonical)) return `not absolute: ${canonical}`;
  const path = new URL(canonical).pathname;
  const norm = path.endsWith('/') ? path : `${path}/`;
  return norm === route ? null : `points at ${path}, page is ${route}`;
});

check('og', 'og:title, og:description, og:image (absolute, exists), twitter:card', ({ head, ogImage }) => {
  const missing = [];
  if (!meta(head, 'property', 'og:title')) missing.push('og:title');
  if (!meta(head, 'property', 'og:description')) missing.push('og:description');
  if (!ogImage) missing.push('og:image');
  else if (!/^https?:\/\//.test(ogImage)) missing.push(`og:image not absolute (${ogImage})`);
  else if (ogImage.startsWith(SITE) && !resolvesInDist(new URL(ogImage).pathname)) missing.push(`og:image 404 (${new URL(ogImage).pathname})`);
  if (!meta(head, 'name', 'twitter:card')) missing.push('twitter:card');
  return missing.length ? missing.join(', ') : null;
});

check('og-extra', 'og:locale and og:image:width/height', ({ head }) => {
  const missing = [];
  if (!meta(head, 'property', 'og:locale')) missing.push('og:locale');
  if (!meta(head, 'property', 'og:image:width')) missing.push('og:image:width');
  if (!meta(head, 'property', 'og:image:height')) missing.push('og:image:height');
  return missing.length ? missing.join(', ') : null;
}, { soft: true });

check('h1', 'exactly one <h1>', ({ body }) => {
  const n = (body.match(/<h1[\s>]/gi) ?? []).length;
  return n === 1 ? null : `${n} h1 elements`;
});

check('jsonld', 'JSON-LD parses', ({ jsonld }) => (jsonld.errors.length ? jsonld.errors.join('; ') : null));

check('schema-sitewide', 'Organization (sameAs, logo resolves) + WebSite', ({ jsonld }) => {
  const org = jsonld.types.get('Organization');
  const missing = [];
  if (!org) missing.push('Organization');
  else {
    if (!Array.isArray(org.sameAs) || org.sameAs.length === 0) missing.push('Organization.sameAs empty');
    const logo = typeof org.logo === 'string' ? org.logo : org.logo?.url;
    if (!logo) missing.push('Organization.logo');
    else if (logo.startsWith(SITE) && !resolvesInDist(new URL(logo).pathname)) missing.push(`Organization.logo 404 (${new URL(logo).pathname})`);
  }
  if (!jsonld.types.has('WebSite')) missing.push('WebSite');
  return missing.length ? missing.join(', ') : null;
});

check('schema-breadcrumb', 'BreadcrumbList on every non-home page', ({ jsonld, route }) => {
  if (route === '/') return null;
  return jsonld.types.has('BreadcrumbList') ? null : 'missing BreadcrumbList';
});

check('schema-blogposting', 'BlogPosting with dateModified + author on posts', ({ jsonld, route }) => {
  if (!BLOG_RE.test(route)) return null;
  const post = jsonld.types.get('BlogPosting');
  if (!post) return jsonld.types.has('Article') ? 'Article instead of BlogPosting' : 'missing BlogPosting';
  const missing = [];
  if (!post.datePublished) missing.push('datePublished');
  if (!post.dateModified) missing.push('dateModified');
  if (!post.author?.name) missing.push('author');
  if (!post.image) missing.push('image');
  return missing.length ? `BlogPosting missing ${missing.join(', ')}` : null;
});

check('schema-faq', 'FAQPage where frontmatter has a faq array', ({ jsonld, route }) => {
  if (!faqByRoute.get(route)) return null;
  return jsonld.types.has('FAQPage') ? null : 'faq in frontmatter but no FAQPage schema';
});

check('schema-software', 'SoftwareApplication on product pages', ({ jsonld, route }) => {
  if (!PRODUCT_ROUTES.has(route)) return null;
  return jsonld.types.has('SoftwareApplication') ? null : 'missing SoftwareApplication';
});

check('hreflang', 'hreflang pairs between / and /it, /de counterparts', ({ route, head, allRoutes }) => {
  const m = route.match(/^\/(it|de)(\/.*)$/);
  const isLocalised = Boolean(m);
  const counterpart = isLocalised ? m[2] : null;
  // Which localised versions of THIS English page exist?
  const localised = isLocalised
    ? []
    : ['it', 'de'].map((l) => `/${l}${route}`).filter((r) => allRoutes.has(r));
  if (!isLocalised && localised.length === 0) return null;
  if (isLocalised && !allRoutes.has(counterpart)) return `no English counterpart at ${counterpart}`;

  const links = [...head.matchAll(/<link\s+[^>]*rel=["']alternate["'][^>]*>/gi)]
    .map((x) => x[0])
    .filter((t) => /hreflang=/i.test(t))
    .map((t) => ({ lang: attrOf(t, 'hreflang'), href: attrOf(t, 'href') }));
  if (links.length === 0) return 'no hreflang links';
  const has = (lang, path) => links.some((l) => l.lang === lang && l.href && new URL(l.href, SITE).pathname.replace(/\/$/, '') === path.replace(/\/$/, ''));
  const missing = [];
  if (isLocalised) {
    if (!has(m[1], route)) missing.push(`self (${m[1]})`);
    if (!has('en', counterpart)) missing.push('en');
    if (!has('x-default', counterpart)) missing.push('x-default');
  } else {
    if (!has('en', route)) missing.push('en');
    if (!has('x-default', route)) missing.push('x-default');
    for (const r of localised) { const l = r.slice(1, 3); if (!has(l, r)) missing.push(l); }
  }
  return missing.length ? `missing hreflang: ${missing.join(', ')}` : null;
});

check('sitemap', 'in sitemap iff indexable', ({ route, noindex }) => {
  if (!sitemap) return 'no sitemap-index.xml';
  const listed = sitemap.has(route);
  if (noindex && listed) return 'noindex page listed in sitemap';
  if (!noindex && !listed) return 'indexable page missing from sitemap';
  return null;
});

check('links', 'internal links resolve inside dist', ({ body, head }) => {
  const hrefs = [...(head + body).matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi)].map((x) => decode(x[1]));
  const bad = [];
  const redir = [];
  for (const href of new Set(hrefs)) {
    let path;
    if (href.startsWith('/')) path = href;
    else if (href.startsWith(SITE)) path = href.slice(SITE.length) || '/';
    else continue;
    if (path.startsWith('//')) continue;
    if (path.startsWith('/#') || path === '/' ) continue;
    if (resolvesInDist(path)) continue;
    const r = redirectFor(path);
    if (r) redir.push(`${path} -> ${r.to}`);
    else bad.push(path);
  }
  const parts = [];
  if (bad.length) parts.push(`404: ${bad.join(', ')}`);
  if (redir.length) parts.push(`redirect: ${redir.join(', ')}`);
  return bad.length ? parts.join(' | ') : null;
});

check('links-redirect', 'internal links do not go through _redirects', ({ body, head }) => {
  const hrefs = [...(head + body).matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi)].map((x) => decode(x[1]));
  const redir = [];
  for (const href of new Set(hrefs)) {
    const path = href.startsWith('/') ? href : href.startsWith(SITE) ? href.slice(SITE.length) || '/' : null;
    if (!path || path.startsWith('//') || path.startsWith('/#')) continue;
    if (resolvesInDist(path)) continue;
    const r = redirectFor(path);
    if (r) redir.push(`${path} -> ${r.to}`);
  }
  return redir.length ? redir.join(', ') : null;
}, { soft: true });

const GENERIC_ALT = /^(image|photo|picture|screenshot|logo|icon|graphic|banner|img|notion image|untitled|)$/i;
check('img-alt', '<img> has meaningful alt', ({ body }) => {
  const imgs = [...body.matchAll(/<img\s+[^>]*>/gi)].map((x) => x[0]);
  const bad = [];
  for (const tag of imgs) {
    const alt = attrOf(tag, 'alt');
    const src = attrOf(tag, 'src') ?? '?';
    // alt="" is correct for decorative images only when explicitly marked so.
    if (alt === undefined) bad.push(`${src}: no alt`);
    else if (alt !== '' && GENERIC_ALT.test(alt.trim())) bad.push(`${src}: generic alt "${alt}"`);
    else if (alt === '' && !/aria-hidden|role=["']presentation["']/.test(tag)) bad.push(`${src}: empty alt without role=presentation`);
  }
  return bad.length ? bad.join(', ') : null;
});

check('img-dims', '<img> has width and height', ({ body }) => {
  const imgs = [...body.matchAll(/<img\s+[^>]*>/gi)].map((x) => x[0]);
  const bad = imgs.filter((t) => !attrOf(t, 'width') || !attrOf(t, 'height')).map((t) => attrOf(t, 'src') ?? '?');
  return bad.length ? bad.join(', ') : null;
});

// ── Per-page extraction ──────────────────────────────────────────────────────
function parseJsonLd(html) {
  // Drop ordinary <script> blocks first: a widget that builds an ld+json
  // snippet as a JS string would otherwise be read as a broken schema block.
  // Browsers see the same boundary (a literal </script> ends a script), so
  // this matches what a crawler's parser does.
  const markup = html.replace(/<script(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '');
  const blocks = [...markup.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const errors = [];
  const nodes = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      const flat = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of flat) {
        nodes.push(n);
        if (Array.isArray(n['@graph'])) nodes.push(...n['@graph']);
      }
    } catch (e) {
      errors.push(`invalid JSON-LD: ${e.message.slice(0, 60)}`);
    }
  }
  const types = new Map();
  for (const n of nodes) {
    const t = n?.['@type'];
    for (const type of Array.isArray(t) ? t : [t]) if (type && !types.has(type)) types.set(type, n);
  }
  return { errors, types, count: nodes.length };
}

const files = walk(DIST).filter((f) => !f.includes(`${DIST}/404`));
const allRoutes = new Set(files.map(routeOf));
const pages = files.map((file) => {
  const html = readFileSync(file, 'utf8');
  const head = headOf(html);
  const body = bodyOf(html);
  const title = decode(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const robots = meta(head, 'name', 'robots') ?? '';
  return {
    route: routeOf(file),
    html, head, body, title,
    description: meta(head, 'name', 'description'),
    canonical: head.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
      ?? head.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1],
    ogImage: meta(head, 'property', 'og:image'),
    noindex: /noindex/i.test(robots),
    jsonld: parseJsonLd(html),
    allRoutes,
  };
});

// ── RSS ──────────────────────────────────────────────────────────────────────
function auditRss() {
  const file = join(DIST, 'rss.xml');
  if (!existsSync(file)) return { ok: false, why: 'dist/rss.xml missing' };
  const xml = readFileSync(file, 'utf8');
  if (!/^\s*<\?xml/.test(xml)) return { ok: false, why: 'no XML declaration' };
  if (!/<rss[\s>]/.test(xml) || !/<channel>/.test(xml)) return { ok: false, why: 'no <rss>/<channel>' };
  // Cheap well-formedness: every opened element is closed in order.
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[0].startsWith('<?') || m[0].startsWith('<!')) continue;
    if (m[3] === '/') continue;
    if (m[1] === '/') { if (stack.pop() !== m[2]) return { ok: false, why: `unbalanced </${m[2]}>` }; }
    else stack.push(m[2]);
  }
  if (stack.length) return { ok: false, why: `unclosed <${stack.at(-1)}>` };
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  if (items.length === 0) return { ok: false, why: 'no <item>' };
  const problems = [];
  for (const item of items) {
    const link = item.match(/<link>(.*?)<\/link>/)?.[1];
    if (!item.includes('<title>')) problems.push('item without title');
    if (!item.includes('<pubDate>')) problems.push('item without pubDate');
    if (!link) problems.push('item without link');
    else if (link.startsWith(SITE) && !resolvesInDist(new URL(link).pathname)) problems.push(`link 404: ${link}`);
  }
  return problems.length ? { ok: false, why: problems.join(', ') } : { ok: true, items: items.length };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const results = CHECKS.map((c) => {
  const failures = [];
  let applicable = 0;
  for (const page of pages) {
    const why = c.fn(page);
    if (why === null || why === undefined) { applicable++; continue; }
    applicable++;
    failures.push({ route: page.route, why });
  }
  return { id: c.id, label: c.label, soft: c.soft, pages: applicable, pass: applicable - failures.length, fail: failures.length, failures };
});
const rss = auditRss();

const robotsTxt = existsSync(join(DIST, 'robots.txt')) ? readFileSync(join(DIST, 'robots.txt'), 'utf8') : '';
const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot'];
const botsListed = AI_BOTS.filter((b) => new RegExp(`^User-agent:\\s*${b}\\s*$`, 'mi').test(robotsTxt));
const robotsSitemap = /^Sitemap:\s*https?:\/\/\S+/mi.test(robotsTxt);

if (JSON_OUT) {
  console.log(JSON.stringify({
    pages: pages.length,
    checks: results.map(({ id, label, soft, pages, pass, fail, failures }) => ({ id, label, soft, pages, pass, fail, failures })),
    rss,
    robots: { aiBots: botsListed, aiBotsMissing: AI_BOTS.filter((b) => !botsListed.includes(b)), sitemap: robotsSitemap },
    sitemapUrls: sitemap ? sitemap.size : 0,
  }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pages.length} pages in dist/ · ${sitemap?.size ?? 0} URLs in sitemap\n`);
console.log(`${pad('check', 52)} ${pad('pages', 6)} ${pad('pass', 5)} ${pad('fail', 5)} result`);
console.log('-'.repeat(84));
for (const r of results) {
  const status = r.fail === 0 ? 'PASS' : r.soft ? 'WARN' : 'FAIL';
  console.log(`${pad(r.label, 52)} ${pad(r.pages, 6)} ${pad(r.pass, 5)} ${pad(r.fail, 5)} ${status}`);
}
console.log(`${pad('RSS parses, items resolve', 52)} ${pad(1, 6)} ${pad(rss.ok ? 1 : 0, 5)} ${pad(rss.ok ? 0 : 1, 5)} ${rss.ok ? `PASS (${rss.items} items)` : `FAIL ${rss.why}`}`);
console.log(`${pad('robots.txt names AI crawlers + Sitemap', 52)} ${pad(1, 6)} ${pad(botsListed.length === AI_BOTS.length && robotsSitemap ? 1 : 0, 5)} ${pad(botsListed.length === AI_BOTS.length && robotsSitemap ? 0 : 1, 5)} ${botsListed.length}/${AI_BOTS.length} bots${robotsSitemap ? ', sitemap ok' : ', NO Sitemap line'}`);

const failing = results.filter((r) => r.fail > 0);
if (failing.length) {
  console.log('\nFailures');
  for (const r of failing) {
    console.log(`\n[${r.soft ? 'warn' : 'fail'}] ${r.label}`);
    const list = VERBOSE ? r.failures : r.failures.slice(0, 20);
    for (const f of list) console.log(`  ${f.route}  ${f.why}`);
    if (!VERBOSE && r.failures.length > 20) console.log(`  … ${r.failures.length - 20} more (--verbose)`);
  }
}
const missingBots = AI_BOTS.filter((b) => !botsListed.includes(b));
if (missingBots.length) console.log(`\nrobots.txt does not name: ${missingBots.join(', ')}`);

const hardFail = results.some((r) => !r.soft && r.fail > 0) || !rss.ok;
process.exit(hardFail ? 1 : 0);
