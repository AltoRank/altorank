#!/usr/bin/env node
// Per-post social cards.
//
// Every page on the site shared one image: the product card in
// public/og-default.png. A post about SendGrid's pricing and a post about
// schema markup arrived in a Slack channel looking identical, and identical to
// the pricing page. The card is the only part of a link most people read before
// deciding whether to open it, so it may as well say what the link is.
//
// Static PNGs written at build time rather than an image endpoint: this site
// deploys to Cloudflare Pages as plain files, and ten posts is not a reason to
// put a renderer in the request path.
//
// Run: npm run og:posts   (or npm run og, which does both cards)

import sharp from 'sharp';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = resolve(__dirname, '..', 'src', 'content', 'blog');
const OUT_DIR = resolve(__dirname, '..', 'public', 'og');

const W = 1200;
const H = 630;

/** SVG has no text wrapping, so lines are measured and broken here. */
function wrap(text, maxWidth, charWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length * charWidth > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Titles carry colons, apostrophes and ampersands; SVG is XML. */
function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Title frontmatter only. A full YAML parse would pull in a dependency to read
 * one field that is always on its own line and always quoted.
 */
function frontmatterTitle(raw) {
  const block = raw.split(/^---\s*$/m)[1];
  if (!block) return null;
  const m = block.match(/^title:\s*"([^"]*)"\s*$/m) ?? block.match(/^title:\s*(.+)\s*$/m);
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

function card(title) {
  // Long titles get a smaller face rather than a card that overflows. Three
  // sizes covers every post we have; the wrap width follows the size.
  const size = title.length > 90 ? 44 : title.length > 60 ? 52 : 60;
  const charWidth = size * 0.52;
  const lines = wrap(title, 1000, charWidth).slice(0, 4);
  const lineHeight = size * 1.18;
  // Bottom-anchored so the block grows upward and the footer never moves.
  const firstBaseline = 452 - (lines.length - 1) * lineHeight;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FDFCFA"/>
      <stop offset="100%" stop-color="#F4F2EE"/>
    </linearGradient>
    <radialGradient id="accentGlow" cx="0.85" cy="0.15" r="0.7">
      <stop offset="0%" stop-color="#EEF0FF" stop-opacity="0.9"/>
      <stop offset="60%" stop-color="#EEF0FF" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#EEF0FF" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#accentGlow)"/>

  <text x="80" y="100" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#1A1815" letter-spacing="-0.8">AltoRank</text>

  <!-- Says which section of the site this is, because the title alone does
       not distinguish a post from a landing page. -->
  <text x="80" y="160" font-family="JetBrains Mono, Menlo, monospace" font-size="15" font-weight="500" fill="#5A52D1" letter-spacing="1.2">BLOG</text>

${lines
  .map(
    (l, i) =>
      `  <text x="80" y="${Math.round(firstBaseline + i * lineHeight)}" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" fill="#1A1815" letter-spacing="-1.2">${esc(l)}</text>`,
  )
  .join('\n')}

  <g transform="translate(80, 560)">
    <text x="0" y="0" font-family="JetBrains Mono, Menlo, monospace" font-size="14" font-weight="500" fill="#7A746B" letter-spacing="0.5">altorank.co</text>
    <line x1="120" y1="-5" x2="120" y2="5" stroke="#D9D5CE" stroke-width="1"/>
    <text x="140" y="0" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="14" font-weight="500" fill="#7A746B">Open source, AGPL-3.0. Self-host it free.</text>
  </g>

  <rect x="${W - 8}" y="0" width="8" height="${H}" fill="#5A52D1"/>
</svg>
`;
}

const files = (await readdir(BLOG_DIR)).filter((f) => /\.mdx?$/.test(f));
await mkdir(OUT_DIR, { recursive: true });

let written = 0;
const skipped = [];

for (const file of files) {
  const raw = await readFile(join(BLOG_DIR, file), 'utf8');
  const title = frontmatterTitle(raw);
  const slug = file.replace(/\.mdx?$/, '');

  if (!title) {
    // Loud, not silent: a post with no card falls back to the generic one and
    // nobody would notice from the output.
    skipped.push(slug);
    continue;
  }

  const png = await sharp(Buffer.from(card(title))).png().toBuffer();
  await writeFile(join(OUT_DIR, `${slug}.png`), png);
  written++;
}

console.log(`✓ ${written} post cards in public/og/  ·  1200×630 · png`);
if (skipped.length) {
  console.warn(`⚠ no title frontmatter, falling back to og-default: ${skipped.join(', ')}`);
  process.exitCode = 1;
}
