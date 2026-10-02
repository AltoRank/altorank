// ---------------------------------------------------------------------------
// The process-global spend reporter stays out of the app
// ---------------------------------------------------------------------------
//
// lib/seo/client.ts `setSpendReporter` is one callback for the whole process.
// Armed from a route or a lib module, two pieces of work on one warm instance
// arm it over each other and bill each other's calls (found 2026-09-28). The
// app attributes spend with `withSpendScope` (lib/billing/spend-scope.ts),
// which travels with the work. Scripts run one piece of work per process and
// may keep the reporter; nothing under app/ or lib/ may call it.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = join(__dirname, "..", "..", "..");
const DEFINES = join(WEB, "lib", "seo", "client.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("spend attribution in the app", () => {
  const files = [...sources(join(WEB, "app")), ...sources(join(WEB, "lib"))];

  it("reads the app and lib trees at all", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(DEFINES);
  });

  it("never arms the process-global reporter: spend goes through a scope", () => {
    const arming = files
      .filter((f) => f !== DEFINES)
      .filter((f) => /\bsetSpendReporter\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(WEB, f));
    expect(arming, "use withSpendScope (lib/billing/spend-scope.ts), not setSpendReporter").toEqual([]);
  });
});
