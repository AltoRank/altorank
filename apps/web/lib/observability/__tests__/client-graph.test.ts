import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * No client component may reach a server-only module.
 *
 * This is already a build failure, but a badly signposted one. Turbopack
 * reports it at `lib/supabase/server.ts:3` — "You're importing a module that
 * depends on next/headers" — with an import trace several hops long, so the
 * file named in the error is never the file that caused it. #172 hit exactly
 * that: a client dialog wanted one number out of lib/cms/delivery.ts,
 * delivery wanted the event recorder, the recorder wanted the service client.
 * The round-2 wave hit the same class with `node:crypto`.
 *
 * `npm run test` runs before `npm run build` in CI, so this fails first and
 * names the whole chain. The fix is never to delete the import: it is to
 * split the module so the pure half is importable from both sides, or to put
 * the work behind a server action.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SEARCH_DIRS = ["app", "components", "lib", "hooks"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Modules that must never end up in a browser bundle, and why. */
const SERVER_ONLY: Record<string, string> = {
  "lib/supabase/server.ts": "holds the service role key and imports next/headers",
  "lib/observability/record.ts": "writes system_events with the service client (import ./event instead)",
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".next")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.includes(path.extname(entry))) out.push(full);
  }
  return out;
}

const FILES = SEARCH_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const source = new Map<string, string>();
for (const f of FILES) source.set(f, readFileSync(f, "utf8"));

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

/** The first statement, ignoring the long comment blocks this repo opens files with. */
function directive(text: string): "client" | "server" | null {
  const head = text.slice(0, 4000);
  const stripped = head.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const first = stripped.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (/^["']use client["']/.test(first)) return "client";
  if (/^["']use server["']/.test(first)) return "server";
  return null;
}

/**
 * Import specifiers that survive to runtime. `import type` and
 * `export type ... from` are erased by the compiler and cannot pull a module
 * into a bundle, so they are not edges.
 */
function imports(text: string): string[] {
  const out: string[] = [];
  const withClause = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = withClause.exec(text))) {
    if (/^\s*type\s/.test(m[1])) continue;
    out.push(m[2]);
  }
  // `import "./side-effect"`, which has no clause at all.
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = bare.exec(text))) out.push(m[1]);
  return out;
}

/** Resolve a specifier the way the bundler does. Null for a package. */
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;

  for (const ext of EXTENSIONS) if (source.has(base + ext)) return base + ext;
  if (source.has(base)) return base;
  for (const ext of EXTENSIONS) {
    const index = path.join(base, `index${ext}`);
    if (source.has(index)) return index;
  }
  return null;
}

/** Depth-first from one client component to the first server-only module it reaches. */
function chainToServerModule(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; trail: string[] }[] = [{ file: entry, trail: [rel(entry)] }];

  while (stack.length) {
    const { file, trail } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const text = source.get(file);
    if (text === undefined) continue;

    // A "use server" module is a boundary Next understands: the client gets a
    // reference, not the code. Legitimate, and where the fix usually lands.
    if (file !== entry && directive(text) === "server") continue;

    if (file !== entry && SERVER_ONLY[rel(file)]) return trail;

    for (const spec of imports(text)) {
      const target = resolve(file, spec);
      if (target && !seen.has(target)) stack.push({ file: target, trail: [...trail, rel(target)] });
    }
  }
  return null;
}

describe("client components never reach a server-only module", () => {
  const clients = FILES.filter((f) => directive(source.get(f)!) === "client");

  it("found the client components to check", () => {
    // A directive parser or resolver that quietly matched nothing would make
    // every assertion below pass while checking no code at all.
    expect(clients.length).toBeGreaterThan(20);
  });

  it("knows where the server-only modules are", () => {
    for (const target of Object.keys(SERVER_ONLY)) {
      expect(source.has(path.join(ROOT, target)), `${target} moved; update this test`).toBe(true);
    }
  });

  it.each(Object.keys(SERVER_ONLY))("%s stays out of every client graph", (target) => {
    const chains = clients
      .map((f) => chainToServerModule(f))
      .filter((chain): chain is string[] => chain !== null && chain[chain.length - 1] === target)
      .map((chain) => chain.join("\n    -> "));

    expect(chains, `${target} ${SERVER_ONLY[target]}.\n\n  ${chains.join("\n\n  ")}`).toEqual([]);
  });
});
