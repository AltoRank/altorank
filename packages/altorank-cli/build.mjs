// Bundles apps/web/scripts/cli.ts into dist/cli.js.
//
// The CLI source lives in apps/web on purpose: it shares envelope.ts,
// api-keys.ts and agent-client.ts with the MCP server and the HTTP routes, so
// there is exactly one copy of each. This file only points esbuild at it.
// Relative imports in the source resolve without the "@/" alias, which is why
// no tsconfig is needed here.

import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../../apps/web/scripts/cli.ts");
const outfile = join(here, "dist", "cli.js");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  // The source has no top-level await and apps/web compiles its scripts as
  // CJS; keep the bundle CJS so the shebang line works with plain `node`.
  format: "cjs",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

// esbuild keeps the entry file's own hashbang (#!/usr/bin/env tsx). Users
// installing from npm do not have tsx, so swap it for node.
const built = readFileSync(outfile, "utf8").replace(/^#![^\n]*\n/, "");
writeFileSync(outfile, `#!/usr/bin/env node\n${built}`);
chmodSync(outfile, 0o755);
