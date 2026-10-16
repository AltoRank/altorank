// ---------------------------------------------------------------------------
// e2e/README.md names every file that checks the E2E_STUBS switch
// ---------------------------------------------------------------------------
//
// The table is how a reviewer checks what the switch changes. It said six
// call sites while eleven files checked it, one of them before its auth
// check. This fails when the table and the code disagree.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = path.resolve(__dirname, "..", "..");
const SKIP = new Set(["node_modules", ".next", ".next-e2e", "__tests__", "__mocks__"]);

function callSites(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(WEB_DIR, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        if (readFileSync(path.join(WEB_DIR, rel), "utf8").includes("e2eStubsEnabled()")) out.push(rel);
      }
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  return out.filter((f) => f !== "lib/e2e/stubs.ts").sort();
}

function tableFiles(): string[] {
  const readme = readFileSync(path.join(WEB_DIR, "e2e", "README.md"), "utf8");
  const start = readme.indexOf("## The `E2E_STUBS` switch");
  const block = readme.slice(start, readme.indexOf("\n## ", start + 5));
  return [...block.matchAll(/^\| `([^`]+\.tsx?)`/gm)].map((m) => m[1]).sort();
}

describe("e2e/README.md E2E_STUBS table", () => {
  it("finds call sites and rows", () => {
    expect(callSites()).toContain("lib/content/generate.ts");
    expect(tableFiles()).toContain("lib/content/generate.ts");
  });

  it("lists exactly the files that check the switch", () => {
    expect(tableFiles()).toEqual(callSites());
  });

  it("states the count the table holds", () => {
    const readme = readFileSync(path.join(WEB_DIR, "e2e", "README.md"), "utf8");
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    const n = callSites().length;
    expect(readme).toContain(`${(words[n] ?? String(n)).replace(/^./, (c) => c.toUpperCase())} production files`);
  });
});
