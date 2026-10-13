import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every `.from("<table>")` in the app names a table or view the migrations
 * create.
 *
 * Migration 085 renamed `agencies` to `accounts` on 2026-09-09 and the sweep
 * that followed missed one read: the Stripe `trial_will_end` handler kept
 * asking for `agencies`. PostgREST answers an unknown table with an error,
 * the handler read `data` as "no account" and stopped, so the email three
 * days before a trial's first charge was never sent - and nothing logged it.
 * Found by review on 2026-09-25. This reads the migrations and the sources so
 * a rename cannot leave a caller behind again.
 */
const WEB = join(__dirname, "..", "..", "..");
const MIGRATIONS = join(WEB, "supabase", "migrations");

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Tables and views the migrations leave behind, replayed in file order. */
function schemaTables(): Set<string> {
  const tables = new Set<string>();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const statement =
    /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?|alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+rename\s+to\s+"?([a-z_][a-z0-9_]*)"?|drop\s+(?:materialized\s+)?(?:table|view)\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, file), "utf8"));
    for (const m of sql.matchAll(statement)) {
      if (m[1]) tables.add(m[1].toLowerCase());
      else if (m[2] && m[3]) {
        tables.delete(m[2].toLowerCase());
        tables.add(m[3].toLowerCase());
      } else if (m[4]) tables.delete(m[4].toLowerCase());
    }
  }
  return tables;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "__tests__" && entry !== "node_modules") walk(p, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** `.from("x")` calls on a database client; storage buckets use `storage.from`. */
function tableReads(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g)) {
    const before = src.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
    if (/storage\s*$/.test(before.replace(/\s+/g, ""))) continue;
    names.push(m[1]);
  }
  return names;
}

describe("table names in .from() exist in the migrations", () => {
  const tables = schemaTables();
  const sources = ["app", "lib", "components", "scripts"].flatMap((d) => walk(join(WEB, d)));

  it("reads the schema and the sources", () => {
    expect(tables.has("accounts")).toBe(true);
    expect(tables.has("agencies")).toBe(false);
    expect(sources.length).toBeGreaterThan(100);
  });

  it("no source names a table the migrations never created or renamed away", () => {
    const offenders = sources.flatMap((p) =>
      tableReads(readFileSync(p, "utf8"))
        .filter((t) => !tables.has(t))
        .map((t) => `${relative(WEB, p)}: ${t}`),
    );
    expect(offenders).toEqual([]);
  });
});
