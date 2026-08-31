#!/usr/bin/env node
// Emits the standalone AltoRank mark into every place that needs it.
// Run with: `npm run brand:generate` from apps/marketing.
//
// Why a generator rather than checked-in SVG files: the mark's path already
// exists in src/components/shared/Logo.astro and in the two raster scripts,
// each of which documents itself as a matched copy. Hand-adding more .svg files
// would make a fourth and fifth copy that nothing keeps in sync. This script is
// the single writer for every standalone asset, so the path lives in one more
// place, deliberately, and everything downstream is generated from it.
//
// Outputs, into BOTH apps/marketing/public/brand and apps/web/public/brand:
//   altorank-mark.svg        ink on transparent, for light backgrounds
//   altorank-mark-white.svg  white on transparent, for dark backgrounds
//   altorank-mark.png        512px ink, for contexts that cannot take SVG
//   altorank-mark-white.png  512px white
//   altorank-icon.png        512px, mark knocked out of the ink squircle
//
// apps/web also gets the favicon set, so the dashboard stops serving Next.js
// starter icons.

import sharp from 'sharp';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const marketingPublic = resolve(__dirname, '..', 'public');
const webPublic = resolve(__dirname, '..', '..', 'web', 'public');

const INK = '#1A1815';
const PAPER = '#FDFCFA';

// Matches src/components/shared/Logo.astro. Change both together.
const MARK = 'M16 0 L24 0 L40 46 L29.5 46 L20 14 L9.5 46 L0 46 Z';
const VIEWBOX = '0 0 40 46';

const markSvg = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="40" height="46" role="img" aria-label="AltoRank">
  <path d="${MARK}" fill="${fill}"/>
</svg>
`;

// Squircle app icon. Glyph is 40x46 spanning 0..40 x 0..46; at scale 0.4435
// that is 17.74 x 20.40, so these offsets centre it in a 32 box.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="${INK}"/>
  <g transform="translate(7.13 5.80) scale(0.4435)">
    <path d="${MARK}" fill="${PAPER}"/>
  </g>
</svg>`;

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 384 })
    .resize({ height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

const targets = [marketingPublic, webPublic].filter((d) => existsSync(d));
if (targets.length < 2) {
  console.warn('⚠ expected both public dirs; found:', targets.join(', '));
}

for (const pub of targets) {
  const brand = join(pub, 'brand');
  await mkdir(brand, { recursive: true });

  await writeFile(join(brand, 'altorank-mark.svg'), markSvg(INK));
  await writeFile(join(brand, 'altorank-mark-white.svg'), markSvg('#FFFFFF'));
  await writeFile(join(brand, 'altorank-mark.png'), await png(markSvg(INK), 512));
  await writeFile(join(brand, 'altorank-mark-white.png'), await png(markSvg('#FFFFFF'), 512));
  await writeFile(
    join(brand, 'altorank-icon.png'),
    await sharp(Buffer.from(iconSvg), { density: 384 }).resize(512, 512).png({ compressionLevel: 9 }).toBuffer(),
  );
  console.log(`✓ ${brand.replace(resolve(__dirname, '..', '..', '..'), '.')}`);
}

// The dashboard was serving Create Next App's default icons. Share the set the
// marketing site already generates rather than maintaining a second one.
if (existsSync(webPublic)) {
  for (const f of ['favicon.ico', 'favicon.svg', 'favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-default.png']) {
    const from = join(marketingPublic, f);
    if (existsSync(from)) await copyFile(from, join(webPublic, f));
  }
  console.log('✓ favicon set + og-default copied into apps/web/public');
}
