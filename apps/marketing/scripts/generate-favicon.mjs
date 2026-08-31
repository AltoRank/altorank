#!/usr/bin/env node
// Generates the full favicon set from a single SVG source.
// Run with: `npm run favicon:generate`
//
// Outputs:
//   favicon.ico          16 + 32 + 48, PNG-encoded (browsers request /favicon.ico
//                        by default; without it every page logs a 404)
//   favicon.svg          modern browsers prefer this
//   favicon.png          32x32 raster fallback
//   apple-touch-icon.png 180x180, iOS home screen
//   icon-192.png         Android / PWA
//   icon-512.png         Android / PWA splash
//   site.webmanifest     ties the PWA icons together
//
// One mark at every size, which the old "AR" lettermark could not manage.
//
// That mark needed two drawings: at 16x16 each stroke of "AR" landed at roughly
// one pixel and anti-aliased to grey, and the accent dot (r=3.5 in a 32 viewBox)
// came out under 2px, so the set carried a separate single-"A" glyph for the
// small sizes. Our mark is one solid shape with no interior detail and no dot, so it downscales to 16 cleanly and the fallback drawing is gone.
//
// The path is duplicated from src/components/shared/Logo.astro. This script
// cannot import an .astro file, so the two must be changed together. There is
// no third copy.

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');

const INK = '#1A1815';
const PAPER = '#FDFCFA';
const ACCENT = '#5A52D1';

/** The mark, knocked out of a rounded square. Matches Logo.astro. */
const MARK_A = 'M16 0 L24 0 L40 46 L29.5 46 L20 14 L9.5 46 L0 46 Z';

// Glyph is 40x46 with bounds exactly 0..40 x 0..46. At scale 0.4435 that is
// 17.74x20.40, so the offsets below centre it in the 32 box.
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="${INK}"/>
  <g transform="translate(7.13 5.80) scale(0.4435)">
    <path d="${MARK_A}" fill="${PAPER}"/>
  </g>
</svg>`;

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * Minimal ICO container around PNG payloads.
 * Avoids pulling in an encoder dependency. Every browser that matters has
 * supported PNG-in-ICO since IE11.
 * Layout: 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per image, then payloads.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ── SVG (served directly to modern browsers) ──────────────────────────────
await writeFile(resolve(publicDir, 'favicon.svg'), mark);

// ── Raster set ────────────────────────────────────────────────────────────
const [i16, i32, i48, i180, i192, i512] = await Promise.all([
  png(mark, 16),
  png(mark, 32),
  png(mark, 48),
  png(mark, 180),
  png(mark, 192),
  png(mark, 512),
]);

await writeFile(resolve(publicDir, 'favicon.ico'), buildIco([
  { size: 16, data: i16 },
  { size: 32, data: i32 },
  { size: 48, data: i48 },
]));
await writeFile(resolve(publicDir, 'favicon.png'), i32);
await writeFile(resolve(publicDir, 'apple-touch-icon.png'), i180);
await writeFile(resolve(publicDir, 'icon-192.png'), i192);
await writeFile(resolve(publicDir, 'icon-512.png'), i512);

await writeFile(
  resolve(publicDir, 'site.webmanifest'),
  JSON.stringify(
    {
      name: 'AltoRank',
      short_name: 'AltoRank',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
      theme_color: INK,
      background_color: PAPER,
      display: 'standalone',
    },
    null,
    2,
  ) + '\n',
);

console.log(
  '✓ favicon.ico (16/32/48), favicon.svg, favicon.png (32), ' +
    'apple-touch-icon.png (180), icon-192.png, icon-512.png, site.webmanifest',
);
