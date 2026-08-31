#!/usr/bin/env node
// Renders a built page to a PDF leave-behind.
//   npm run pdf                       -> /agency-blueprint to ~/Downloads
//   npm run pdf -- /open-source       -> any other route
//
// Run `npm run build` first; this reads from dist/.
//
// Three things this handles that a plain Cmd+P does not:
//   1. Serves from a copy of dist with in-page links rewritten to absolute
//      altorank.co URLs. Rendering from localhost otherwise bakes
//      "http://localhost:PORT/pricing" into the PDF's link annotations, which
//      ships dead links to whoever you send it to.
//   2. Appends ?print=1, which the inline script in Base.astro uses to expand
//      every <details> block. Headless Chrome does not reliably fire
//      beforeprint, and a closed <details> hides its content in the UA shadow
//      DOM where the print stylesheet cannot reach it, so FAQ answers vanish.
//   3. Relies on the @media print rules in globals.css to drop the nav,
//      breadcrumb, footer, and CTA banner, and to stop cards splitting across
//      sheets.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, cp, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = join(root, 'dist');
const route = (process.argv[2] || '/agency-blueprint').replace(/^\/|\/$/g, '');
const outFile = join(homedir(), 'Downloads', `AltoRank-${route.replace(/\//g, '-')}.pdf`);
const PORT = 4399;
const SITE = 'https://altorank.co';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.CHROME_PATH,
].find((p) => p && existsSync(p));

if (!existsSync(dist)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.');
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), 'altorank-pdf-'));
await cp(dist, work, { recursive: true });

const page = join(work, route, 'index.html');
if (!existsSync(page)) {
  console.error(`Route not found in dist: /${route}`);
  await rm(work, { recursive: true, force: true });
  process.exit(1);
}

// Absolutise in-page links only. Asset paths (_astro, icons, manifest) must stay
// relative so the local render still finds them.
const html = await readFile(page, 'utf8');
const ASSET = /^(_astro|favicon|apple|icon|site\.|og-)/;
let rewritten = 0;
await writeFile(
  page,
  html.replace(/href="\/([^"]*)"/g, (m, path) => {
    if (ASSET.test(path)) return m;
    rewritten++;
    return `href="${SITE}/${path}"`;
  }),
  'utf8',
);

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml', '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(work, path.endsWith('/') ? join(path, 'index.html') : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));

const code = await new Promise((done) => {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=15000',
    `--print-to-pdf=${outFile}`,
    `http://localhost:${PORT}/${route}/index.html?print=1`,
  ], { stdio: 'ignore' });
  chrome.on('exit', done);
});

server.close();
await rm(work, { recursive: true, force: true });

if (code !== 0) {
  console.error(`Chrome exited ${code}`);
  process.exit(code);
}

const pdf = await readFile(outFile);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`✓ ${outFile}`);
console.log(`  ${pages} pages, ${Math.round(pdf.length / 1024)} KB, ${rewritten} links absolutised to ${SITE}`);
