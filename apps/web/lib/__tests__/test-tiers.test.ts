// ---------------------------------------------------------------------------
// A test that talks to a database says so in its name
// ---------------------------------------------------------------------------
//
// vitest.config.ts puts a file in the `db` tier (local stack, env guard,
// loopback-only network) or the `unit` tier (no database, no network) by its
// name alone. A db test with the wrong name is the dangerous case: written the
// way the two old isolation suites were (its own `.env.local` reader, its own
// createClient, `describe.skipIf(!LIVE)`), it ran unguarded on a laptop and
// skipped green in CI's build job, so it never ran anywhere that counted. The
// unit tier's network guard now fails it on a laptop, but in CI there is no
// stack, the skip wins and the run is green. So this file reads the source of
// every test and support file and fails on the shapes a database test has:
//
// - "env-file": names an env file (`.env.local` and friends) or reaches for
//   an env-file loader (@next/env, dotenv, process.loadEnvFile,
//   util.parseEnv). Only lib/__tests__/support/local-db.ts loads env files for
//   a test, and it takes only the local-stack values and checks them.
// - "local-stack": imports the local-stack helpers outside a *.db.test file.
// - "own-client": builds a real Supabase client (createClient and friends,
//   not a type import) without mocking the module.
// - "conditional": `skipIf` / `runIf` in the unit tier. A unit test runs the
//   same everywhere; one that skips on some machines is a db test, or a test
//   that is quietly not running.
//
// The last three are about vitest's tiers, so they skip e2e/: Playwright is its
// own tier, always talks to the local stack, and gets its URL from
// e2e/fixtures/env.ts, which goes through the same loader and check. The first
// applies there too.
//
// It parses with the TypeScript compiler rather than grepping, so a comment
// that mentions `.env.local` (this one) is not a finding and a template
// literal that builds the path is.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const WEB_DIR = path.resolve(__dirname, "..", "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".next-e2e",
  ".open-next",
  ".wrangler",
  "playwright-report",
  "test-results",
  "coverage",
  "out",
  "build",
  "public",
  "supabase",
]);

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DB_TEST_FILE = /\.db\.(test|spec)\.[cm]?[jt]sx?$/;

/** Files that may do what a unit test may not, and why. */
const ALLOWED: Record<string, Partial<Record<Rule, string>>> = {
  "lib/__tests__/support/local-db.ts": { "env-file": "the one loader; takes only the local-stack values" },
  "lib/__tests__/local-db-guard.test.ts": {
    "env-file": "writes env files into a temp dir to test that loader",
    "local-stack": "the loader's own unit test; it never connects",
  },
  "lib/__tests__/network-guard.test.ts": {
    "own-client": "builds a client for a .invalid host to prove the guard stops it",
  },
};

type Rule = "env-file" | "local-stack" | "own-client" | "conditional";

const ENV_FILE = /(^|[/\\])\.env(\.[\w.-]+)?$/;
const ENV_LOADER_MODULES = new Set(["@next/env", "dotenv", "dotenv/config", "dotenv-expand"]);
const ENV_LOADER_NAMES = new Set(["loadEnvFile", "parseEnv"]);
const CLIENT_MODULES = new Set(["@supabase/supabase-js", "@supabase/ssr"]);
const CLIENT_FACTORIES = new Set(["createClient", "createServerClient", "createBrowserClient"]);

function scriptKind(file: string): ts.ScriptKind {
  if (/\.[cm]?tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx?$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

/** Every rule `text` (the source of the file at `rel`, relative to apps/web) breaks. */
function tierViolations(rel: string, text: string): string[] {
  const isDbTest = DB_TEST_FILE.test(rel);
  // Rules about the vitest tiers do not apply to Playwright's files.
  const vitestTier = !(rel.startsWith("e2e/") || rel === "playwright.config.ts");
  const unitTier = vitestTier && !isDbTest;
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const found: { rule: Rule; detail: string }[] = [];
  const mocked = new Set<string>();
  const clientImports: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (ENV_LOADER_MODULES.has(spec)) found.push({ rule: "env-file", detail: `imports ${spec}` });
      if (/(^|\/)support\/local-db$/.test(spec) && unitTier) {
        found.push({ rule: "local-stack", detail: `imports ${spec} outside a *.db.test file` });
      }
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (CLIENT_MODULES.has(spec) && clause && !clause.isTypeOnly && bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && CLIENT_FACTORIES.has(imported)) clientImports.push(`${imported} from ${spec}`);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      const arg = first && ts.isStringLiteralLike(first) ? first.text : undefined;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "mock" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "vi" &&
        arg
      ) {
        mocked.add(arg);
      }
      if (
        arg &&
        (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require"))
      ) {
        if (ENV_LOADER_MODULES.has(arg)) found.push({ rule: "env-file", detail: `loads ${arg}` });
      }
      if (ts.isPropertyAccessExpression(callee) && ["skipIf", "runIf"].includes(callee.name.text) && unitTier) {
        found.push({ rule: "conditional", detail: `${callee.name.text}(...) at line ${line(src, node)}` });
      }
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (ENV_FILE.test(node.text)) {
        found.push({ rule: "env-file", detail: `names ${JSON.stringify(node.text)} at line ${line(src, node)}` });
      }
    } else if (ts.isIdentifier(node) && ENV_LOADER_NAMES.has(node.text)) {
      found.push({ rule: "env-file", detail: `uses ${node.text} at line ${line(src, node)}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  if (unitTier) {
    for (const imported of clientImports) {
      const spec = imported.split(" from ")[1];
      if (!mocked.has(spec)) {
        found.push({ rule: "own-client", detail: `imports ${imported} without vi.mock("${spec}")` });
      }
    }
  }

  const allowed = ALLOWED[rel] ?? {};
  return found.filter((f) => !allowed[f.rule]).map((f) => `${rel}: [${f.rule}] ${f.detail}`);
}

function line(src: ts.SourceFile, node: ts.Node): number {
  return src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
}

/** Test files, anything under __tests__ / __mocks__ / e2e, and the two runner configs. */
function testSources(): string[] {
  const out: string[] = ["vitest.config.ts", "playwright.config.ts"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(WEB_DIR, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel);
      } else if (
        SOURCE.test(entry.name) &&
        (TEST_FILE.test(entry.name) || /(^|\/)(__tests__|__mocks__)\//.test(rel) || rel.startsWith("e2e/"))
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out;
}

// Parsing a few hundred files takes a second or two alone and several times
// that while the rest of the suite is using every core, so these two get more
// than vitest's default 5s: a timeout here would read as a finding.
describe("test tiers", { timeout: 60_000 }, () => {
  it("finds the test files it is meant to police", () => {
    const files = testSources();
    // A walk that silently found nothing would pass the check below.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("lib/__tests__/tenant-isolation.db.test.ts");
    expect(files).toContain("e2e/fixtures/env.ts");
  });

  it("no file outside the db tier reads env files, uses the local stack or builds a real client", () => {
    const violations = testSources().flatMap((rel) =>
      tierViolations(rel, readFileSync(path.join(WEB_DIR, rel), "utf8")),
    );
    expect(violations).toEqual([]);
  });
});

// The checker, on the exact shape the two old isolation suites had, so a
// refactor of it cannot quietly stop recognising the thing it exists for.
describe("tierViolations", () => {
  const OLD_SUITE = `
    import { readFileSync } from "node:fs";
    import path from "node:path";
    import { createClient, type SupabaseClient } from "@supabase/supabase-js";
    function loadEnv() {
      for (const file of [".env.development.local", ".env.local"]) {
        readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      }
    }
    const LIVE = loadEnv() !== null;
    describe.skipIf(!LIVE)("tenant isolation", () => {});
  `;

  it("flags every part of it when the file is named as a unit test", () => {
    const found = tierViolations("lib/__tests__/tenant-isolation.test.ts", OLD_SUITE);
    expect(found).toEqual([
      expect.stringContaining('[env-file] names ".env.development.local"'),
      expect.stringContaining('[env-file] names ".env.local"'),
      expect.stringContaining("[conditional] skipIf"),
      expect.stringContaining("[own-client] imports createClient from @supabase/supabase-js"),
    ]);
  });

  it("still flags the env-file reader in a db test: only the shared loader may read them", () => {
    const found = tierViolations("lib/__tests__/tenant-isolation.db.test.ts", OLD_SUITE);
    expect(found).toEqual([
      expect.stringContaining('[env-file] names ".env.development.local"'),
      expect.stringContaining('[env-file] names ".env.local"'),
    ]);
  });

  it("flags a path built in a template literal, an env loader, and the local-stack helpers in a unit test", () => {
    const found = tierViolations(
      "lib/foo/__tests__/bar.test.tsx",
      [
        "import { loadEnvConfig } from '@next/env';",
        "import { connectLocalStack } from '@/lib/__tests__/support/local-db';",
        "const file = `${dir}/.env.local`;",
        "process.loadEnvFile(file);",
      ].join("\n"),
    );
    expect(found).toEqual([
      expect.stringContaining("[env-file] imports @next/env"),
      expect.stringContaining("[local-stack] imports @/lib/__tests__/support/local-db"),
      expect.stringContaining('[env-file] names "/.env.local"'),
      expect.stringContaining("[env-file] uses loadEnvFile"),
    ]);
  });

  it("leaves alone what unit tests do all the time: type imports, mocked clients, comments", () => {
    const found = tierViolations(
      "lib/foo/__tests__/bar.test.ts",
      [
        "// reads .env.local in production, see docs",
        "import type { SupabaseClient } from '@supabase/supabase-js';",
        "import { createClient } from '@supabase/supabase-js';",
        "vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));",
        "const message = 'set it in .env.local, then restart';",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });
});
