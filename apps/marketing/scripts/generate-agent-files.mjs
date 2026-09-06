#!/usr/bin/env node
// Post-build. Emits the agent-discovery files into dist/.
// Wired into `npm run build`, so it cannot drift from the site it describes.
//
// Generated rather than hand-written on purpose: a stale llms.txt that lists
// pages which no longer exist is worse than none, and this site gains and loses
// routes regularly.
//
// Emits:
//   dist/llms.txt         llmstxt.org convention, built from the real sitemap
//   dist/.well-known/     nothing yet, deliberately (see NOT-IMPLEMENTED below)
//
// NOT implemented, and that is a decision rather than a gap:
//   /.well-known/mcp/server-card.json  the MCP server is not shipped; a card
//                                      pointing at a dead endpoint is fiction
//   /.well-known/agent-skills/         no skills published yet
//   /.well-known/api-catalog           this is a static marketing site, no API
//   /.well-known/openid-configuration  no protected resources to authenticate to
//   x402 / MPP / UCP / ACP             four competing draft payment protocols,
//                                      and nothing here is sold agentically
// Passing those checks would mean publishing documents that describe
// capabilities we do not have, which is the same failure as fabricated traction.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = join(root, 'dist');
const SITE = 'https://altorank.co';

if (!existsSync(dist)) {
  console.error('dist/ not found; run astro build first');
  process.exit(1);
}

// ── collect the real routes from the built sitemap ───────────────────────────
async function sitemapUrls() {
  const files = (await readdir(dist)).filter((f) => /^sitemap-\d+\.xml$/.test(f));
  const urls = [];
  for (const f of files) {
    const xml = await readFile(join(dist, f), 'utf8');
    urls.push(...[...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]));
  }
  return [...new Set(urls)].sort();
}

// ── pull title + description straight out of the built HTML ──────────────────
async function describe(url) {
  const path = url.replace(SITE, '').replace(/\/$/, '');
  const file = join(dist, path, 'index.html');
  if (!existsSync(file)) return null;
  const html = await readFile(file, 'utf8');
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1]?.trim();
  const desc = html.match(
    /<meta\s+name="description"\s+content="(.*?)"/s,
  )?.[1]?.trim();
  if (!title) return null;
  return {
    url,
    // strip the " | AltoRank" brand suffix; it repeats on every line otherwise
    title: title.replace(/\s*\|\s*AltoRank\s*$/, '').trim(),
    desc: (desc || '').replace(/\s+/g, ' ').trim(),
  };
}

// Grouped the way a reader would want them, not the way the filesystem has them.
const SECTIONS = [
  { name: 'Start here', match: (p) => p === '' || p === '/check' || p === '/open-source' || p === '/pricing' || p === '/agency-blueprint' },
  { name: 'How it works', match: (p) => p === '/approval-first-seo-content' || p.startsWith('/for/') || p.startsWith('/integrations') },
  { name: 'Generative engine optimization', match: (p) => p.startsWith('/geo/') },
  { name: 'Comparisons', match: (p) => p.startsWith('/alternatives/') || p.startsWith('/vs/') },
  { name: 'Writing', match: (p) => p.startsWith('/blog') },
  { name: 'Italiano', match: (p) => p.startsWith('/it/') },
];

const urls = await sitemapUrls();
const pages = (await Promise.all(urls.map(describe))).filter(Boolean);

const lines = [
  '# AltoRank',
  '',
  '> The approval-first, open-source AI SEO content engine. It researches a',
  '> keyword, writes the article, scores it, and publishes it to any of 11 CMS platforms,',
  '> and nothing goes live until a human approves it. Licensed AGPL-3.0.',
  '',
  'AltoRank is pre-launch. There are no paying customers and no case studies, and',
  'the source repository is not public yet. Pages describing the product describe',
  'what is being built. Where a figure appears it is first-party and the method is',
  'stated alongside it.',
  '',
];

const used = new Set();
for (const section of SECTIONS) {
  const inSection = pages.filter((p) => {
    const path = p.url.replace(SITE, '').replace(/\/$/, '');
    return !used.has(p.url) && section.match(path);
  });
  if (!inSection.length) continue;
  inSection.forEach((p) => used.add(p.url));
  lines.push(`## ${section.name}`, '');
  for (const p of inSection) {
    lines.push(p.desc ? `- [${p.title}](${p.url}): ${p.desc}` : `- [${p.title}](${p.url})`);
  }
  lines.push('');
}

const rest = pages.filter((p) => !used.has(p.url));
if (rest.length) {
  lines.push('## Other', '');
  for (const p of rest) lines.push(`- [${p.title}](${p.url})`);
  lines.push('');
}

await writeFile(join(dist, 'llms.txt'), lines.join('\n'), 'utf8');
console.log(`✓ llms.txt (${pages.length} pages across ${SECTIONS.length + (rest.length ? 1 : 0)} sections)`);

// ── markdown twins ───────────────────────────────────────────────────────────
// Every page also gets an index.md. This is the same HTML-to-Markdown step the
// pivot plan puts on the Phase 1 critical path (`core/src/ai/markdown.ts`), so
// it is worth writing properly here and lifting into packages/core later.
//
// Site chrome is stripped via [data-print-hide], the same marker the print
// stylesheet uses. One definition of "this is not content", two consumers.

const DROP_TAGS = /<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CHROME = /<(header|footer|nav|section|div)\b[^>]*\bdata-print-hide\b[^>]*>[\s\S]*?<\/\1>/gi;

const entities = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
   .replace(/&mdash;/g, ', ').replace(/&rarr;/g, '->').replace(/&middot;/g, '·')
   .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&rsquo;/g, '’')
   .replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

const inline = (s) =>
  entities(
    s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `**${t.trim()}**`)
     .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `*${t.trim()}*`)
     .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${t.trim()}\``)
     .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
       const text = t.replace(/<[^>]+>/g, '').trim();
       if (!text) return '';
       const url = href.startsWith('/') ? SITE + href : href;
       return url.startsWith('#') ? text : `[${text}](${url})`;
     })
     .replace(/<br\s*\/?>/gi, '\n')
     .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+/g, ' ').trim();

function htmlToMarkdown(html) {
  let s = html
    .replace(DROP_TAGS, '')
    .replace(CHROME, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Body only; everything above it is head metadata already covered by llms.txt.
  s = s.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? s;

  // Card layouts here are nested divs with no semantic tags, so without a break
  // at each block close the text of six sibling cards concatenates into one
  // unreadable run. Insert a soft boundary before any tags are stripped.
  s = s.replace(/<\/(div|section|article|li|tr|details)>/gi, '\n$&');

  const out = [];

  // Block-level conversion, outermost first so nested inline markup survives.
  s = s.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, t) => {
    const text = inline(t);
    return text ? `\n\n${'#'.repeat(+tag[1])} ${text}\n\n` : '';
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => {
    const text = inline(t);
    return text ? `\n- ${text}` : '';
  });
  s = s.replace(/<(p|summary)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => {
    const text = inline(t);
    return text ? `\n\n${text}\n\n` : '';
  });
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => {
    const text = inline(t);
    return text ? `\n\n> ${text}\n\n` : '';
  });
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) =>
    `\n\n\`\`\`\n${entities(t.replace(/<[^>]+>/g, '')).trim()}\n\`\`\`\n\n`);

  // Tables: header row from <th>, then each <tr>.
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, table) => {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2])),
    ).filter((r) => r.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    const body = rows.map((r) => `| ${pad(r).join(' | ')} |`);
    body.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
    return `\n\n${body.join('\n')}\n\n`;
  });

  out.push(
    inline(s)
      .split('\n')
      .map((line) => line.trimEnd())
      // Source HTML is deeply indented; without this every line carries the
      // markup's leading whitespace and some become accidental code blocks.
      .map((line) => (line.startsWith('- ') ? line : line.trimStart()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n'),
  );
  return out.join('').trim() + '\n';
}

async function walk(dir) {
  const found = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...(await walk(p)));
    else if (e.name === 'index.html') found.push(p);
  }
  return found;
}

const htmlFiles = await walk(dist);
let written = 0;
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const md = htmlToMarkdown(html);
  if (md.trim().length < 40) continue; // skip 404 and other near-empty shells
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1]?.trim() ?? '';
  const url = SITE + file.replace(dist, '').replace(/\/index\.html$/, '/');
  // The page nearly always opens with its own h1; prepending the <title> too
  // would give every document two competing top-level headings.
  const needsTitle = title && !/^#\s/m.test(md.split('\n').slice(0, 3).join('\n'));
  await writeFile(
    file.replace(/index\.html$/, 'index.md'),
    `<!-- source: ${url} -->\n\n` +
      (needsTitle ? `# ${title.replace(/\s*\|\s*AltoRank\s*$/, '')}\n\n` : '') +
      md,
    'utf8',
  );
  written++;
}
console.log(`✓ markdown twins (${written} pages)`);

// Content negotiation needs a Pages Function, which switches the project into
// advanced mode and takes over routing. That is a real deployment risk on a live
// site, so it is opt-in rather than default. Verify with `wrangler pages dev dist`
// before enabling in CI.
if (process.env.AGENT_MD_NEGOTIATION === '1') {
  await writeFile(join(dist, '_worker.js'), `// Generated by scripts/generate-agent-files.mjs
// Serves the .md twin when an agent asks for markdown; HTML stays the default.
export default {
  async fetch(request, env) {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/markdown')) {
      const url = new URL(request.url);
      const path = url.pathname.endsWith('/') ? url.pathname + 'index.md' : url.pathname + '/index.md';
      const md = await env.ASSETS.fetch(new URL(path, url.origin));
      if (md.ok) {
        return new Response(md.body, {
          headers: { 'content-type': 'text/markdown; charset=utf-8', vary: 'accept' },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
`, 'utf8');
  console.log('✓ _worker.js (markdown content negotiation ENABLED)');
}
