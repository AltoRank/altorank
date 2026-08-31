#!/usr/bin/env node
// Generates public/og-default.png — the default social card used when a page
// doesn't supply its own OG image. Run with: `node scripts/generate-og-default.mjs`.
// Re-run when the brand wordmark or tagline changes.

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'public', 'og-default.png');

const W = 1200;
const H = 630;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
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

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#accentGlow)"/>

  <!-- Logotype: the Nomads "A" IS the A, type continues "ltoRank".
       Matches src/components/shared/Logo.astro, including weight 600, which
       is what the solid mark pairs with.
       Geometry: 30px type, Archivo cap height 0.686 -> 20.58 tall, so
       scale = 20.58/46 = 0.4474 and width = 40*0.4474 = 17.90.
       Text baseline sits at y=34, so the mark's feet land there too. -->
  <g transform="translate(80, 70)">
    <g transform="translate(0 13.42) scale(0.4474)">
      <path d="M16 0 L24 0 L40 46 L29.5 46 L20 14 L9.5 46 L0 46 Z" fill="#1A1815"/>
    </g>
    <text x="18.95" y="34" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="30" font-weight="600" fill="#1A1815" letter-spacing="-0.66">ltoRank</text>
  </g>

  <!-- Title. Must track the homepage h1 in src/pages/index.astro. -->
  <text x="80" y="290" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="60" font-weight="600" fill="#1A1815" letter-spacing="-1.5">
    The open-source AI SEO
  </text>
  <text x="80" y="360" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="60" font-weight="600" fill="#1A1815" letter-spacing="-1.5">
    engine that never
  </text>
  <text x="80" y="430" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="60" font-weight="600" fill="#1A1815" letter-spacing="-1.5">
    publishes without you.
  </text>

  <!-- Subhead. Was an em dash, which house style forbids in site copy. -->
  <text x="80" y="498" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="24" font-weight="400" fill="#56514B" letter-spacing="-0.2">
    Keyword research, drafting, and publishing to eleven CMSs.
  </text>

  <!-- Footer row -->
  <g transform="translate(80, 560)">
    <text x="0" y="0" font-family="JetBrains Mono, Menlo, monospace" font-size="14" font-weight="500" fill="#7A746B" letter-spacing="0.5">altorank.co</text>
    <line x1="120" y1="-5" x2="120" y2="5" stroke="#D9D5CE" stroke-width="1"/>
    <text x="140" y="0" font-family="Archivo, Helvetica, Arial, sans-serif" font-size="14" font-weight="500" fill="#7A746B">Open source, AGPL-3.0. Self-host it free.</text>
  </g>

  <!-- Decorative accent stripe -->
  <rect x="${W - 8}" y="0" width="8" height="${H}" fill="#5A52D1"/>
</svg>
`;

await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(outPath);

const stats = await sharp(outPath).metadata();
console.log(`✓ Generated ${outPath}`);
console.log(`  ${stats.width}×${stats.height} · ${stats.format}`);
