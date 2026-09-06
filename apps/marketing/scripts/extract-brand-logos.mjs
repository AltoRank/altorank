#!/usr/bin/env node
// Writes one SVG per publishing destination to public/logos/{CODE}.svg, taken
// from the dashboard's own brand marks so the two apps cannot show different
// logos for the same product.
//
//   source  apps/web/lib/brand-icons.ts   (Simple Icons paths, keyed by the
//                                          integration id, e.g. "wordpress")
//   mapping apps/marketing/src/data/integrations.ts (slug -> two-letter code)
//   output  apps/marketing/public/logos/WP.svg, SH.svg, ...
//
// Deterministic on purpose: same inputs, byte-identical outputs, so two
// branches that both run it produce files git sees as unchanged. No timestamps,
// no formatting that depends on the environment, entries written in the order
// integrations.ts lists them. Destinations with no brand mark (Webhook, Git)
// get no file; BrandLogo.astro falls back to the code for those.
//
//   node scripts/extract-brand-logos.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ICONS_TS = resolve(here, '../../web/lib/brand-icons.ts');
const INTEGRATIONS_TS = resolve(here, '../src/data/integrations.ts');
const OUT_DIR = resolve(here, '../public/logos');

// One entry per line in brand-icons.ts: `  wordpress: { hex: "#21759B", d: "M..." },`
const icons = new Map();
for (const m of readFileSync(ICONS_TS, 'utf8').matchAll(
  /^\s*([a-z0-9_]+):\s*\{\s*hex:\s*(null|"#[0-9A-Fa-f]{6}"),\s*d:\s*"([^"]+)"\s*\}/gm,
)) {
  icons.set(m[1], { hex: m[2] === 'null' ? null : m[2].slice(1, -1), d: m[3] });
}
if (icons.size === 0) throw new Error(`no icons parsed from ${ICONS_TS}`);

// `slug` precedes `code` inside every INTEGRATIONS entry.
const pairs = [...readFileSync(INTEGRATIONS_TS, 'utf8').matchAll(
  /slug:\s*'([a-z0-9-]+)'[^{}]*?code:\s*'([A-Z]{2})'/g,
)].map((m) => ({ slug: m[1], code: m[2] }));
if (pairs.length === 0) throw new Error(`no slug/code pairs parsed from ${INTEGRATIONS_TS}`);

mkdirSync(OUT_DIR, { recursive: true });

const written = [];
const skipped = [];
for (const { slug, code } of pairs) {
  const icon = icons.get(slug);
  if (!icon) {
    skipped.push(`${code} (${slug})`);
    continue;
  }
  // Brand colour where the source publishes one; otherwise currentColor, which
  // BrandLogo.astro inlines so the mark takes the surrounding text colour.
  const fill = icon.hex ?? 'currentColor';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}"><path d="${icon.d}"/></svg>\n`;
  writeFileSync(resolve(OUT_DIR, `${code}.svg`), svg);
  written.push(code);
}

console.log(`wrote ${written.length}: ${written.join(' ')}`);
if (skipped.length) console.log(`no brand mark for: ${skipped.join(', ')}`);
