/**
 * Nothing a browser bundle imports may reach Node.
 *
 * On 2026-09-25 CI's build failed on #251 and a merge would have deployed
 * nothing: a client component (the keyword Generate tab) imported two numbers
 * from the server research pipeline, and through it recommendations ->
 * business-context -> observed-facts -> lib/public-tools/safe-fetch.ts, which
 * imports node:dns. Turbopack refuses a Node builtin in the client graph, so
 * `next build` exited 1 and `next dev` answered 500 on every page that drew
 * the calendar controls. tsc and vitest passed: neither knows which modules
 * end up in the browser. This does, crudely and in a second.
 *
 * It walks the import graph from every "use client" module under app/,
 * components/ and lib/, following static imports, re-exports and dynamic
 * import() as the bundler does, and fails when the walk reaches a Node
 * builtin (`node:*` or a bare builtin name) or the SSRF-safe fetcher. It
 * stops where the bundler stops: at a "use server" module (a client gets a
 * reference to its actions, not its code), at type-only imports (erased), and
 * at packages (their browser builds are the package's business).
 *
 * An import used only as a type but written without `type` is erased by the
 * compiler and still followed here, so a failure can be a false alarm: write
 * the import as `import type` and it goes away. The fix for a real one is the
 * one #251 took - move what the client needs into a module with no server
 * imports (lib/keyword-research/generate-limits.ts).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..");
const SEARCH_DIRS = ["app", "components", "lib"];
/** Server-only modules that are not Node builtins themselves but exist to use them. */
const FORBIDDEN_FILES = new Set(["lib/public-tools/safe-fetch.ts"]);
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

interface Parsed {
  directive: "use client" | "use server" | null;
  specifiers: string[];
}

const parsed = new Map<string, Parsed>();

function parse(file: string): Parsed {
  const hit = parsed.get(file);
  if (hit) return hit;
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let directive: Parsed["directive"] = null;
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use client" || stmt.expression.text === "use server") directive = stmt.expression.text;
  }
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const out = { directive, specifiers };
  parsed.set(file, out);
  return out;
}

/** A source file for a relative or `@/` specifier, or null for a package. */
function resolve(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]);
}

describe("client bundle", () => {
  it("never reaches a Node builtin or the SSRF-safe fetcher from a 'use client' module", () => {
    const entries = SEARCH_DIRS.flatMap((d) => sources(join(ROOT, d))).filter((f) => parse(f).directive === "use client");
    // The walk has something to walk: if this drops to zero the directive
    // detection broke, and the guard would pass by checking nothing.
    expect(entries.length).toBeGreaterThan(50);

    const via = new Map<string, string | null>();
    const queue: string[] = [];
    for (const entry of entries) {
      via.set(entry, null);
      queue.push(entry);
    }
    const chain = (file: string): string => {
      const steps: string[] = [];
      for (let at: string | null = file; at; at = via.get(at) ?? null) steps.unshift(relative(ROOT, at));
      return steps.join(" -> ");
    };

    const problems: string[] = [];
    while (queue.length) {
      const file = queue.shift() as string;
      const rel = relative(ROOT, file);
      if (FORBIDDEN_FILES.has(rel)) {
        problems.push(chain(file));
        continue;
      }
      const { directive, specifiers } = parse(file);
      // A client gets references to a server module's actions, not its code.
      if (directive === "use server") continue;
      for (const specifier of specifiers) {
        if (isBuiltin(specifier)) {
          problems.push(`${chain(file)} -> ${specifier}`);
          continue;
        }
        const next = resolve(file, specifier);
        if (!next || via.has(next)) continue;
        via.set(next, file);
        queue.push(next);
      }
    }
    expect(problems).toEqual([]);
  });
});
