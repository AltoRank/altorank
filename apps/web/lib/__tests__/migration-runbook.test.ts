// ---------------------------------------------------------------------------
// The migration runbook covers every migration file
// ---------------------------------------------------------------------------
//
// Migrations are applied by hand from supabase/migrations/RUNBOOK.md. Its
// post-flight step is "every pre-flight row is `t`", so a file with no row
// passes by being absent, and a file with no line in the apply list is simply
// never applied by someone following it. 102 shipped with its own section but
// no pre-flight row and no apply line, and the fresh-database loop's `0*.sql`
// glob stopped at 099. This fails when a new file is missing from either list
// without an entry below saying why.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "..", "..", "supabase", "migrations");
const RUNBOOK = readFileSync(path.join(DIR, "RUNBOOK.md"), "utf8");
const FILES = readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const num = (f: string) => f.slice(0, 3);

/** Files with no pre-flight row, and why. */
const NO_PREFLIGHT_ROW: Record<string, string> = {
  "063": "a one-shot data backfill leaves nothing to detect (see the note under the query)",
  "083": "shipped without a runbook entry; checked by hand before 084",
  "086": "shipped without a runbook entry; checked by hand before 091",
  "087": "shipped without a runbook entry; checked by hand before 091",
  "088": "shipped without a runbook entry; checked by hand before 091",
  "089": "shipped without a runbook entry; checked by hand before 091",
  "090": "shipped without a runbook entry; checked by hand before 091",
};

/** The production apply list starts at 048; these files from 048 on have no line in it, and why. */
const NO_APPLY_LINE: Record<string, string> = {
  "083": "shipped without a runbook entry",
  "086": "shipped without a runbook entry",
  "087": "shipped without a runbook entry",
  "088": "shipped without a runbook entry",
  "089": "shipped without a runbook entry",
  "090": "shipped without a runbook entry",
};

function preflightRows(): Set<string> {
  const start = RUNBOOK.indexOf("## 1. Pre-flight");
  const end = RUNBOOK.indexOf("## 2.", start);
  const block = RUNBOOK.slice(start, end);
  return new Set([...block.matchAll(/^\s*\('(\d{3})_/gm)].map((m) => m[1]));
}

function applyLines(): Set<string> {
  return new Set([...RUNBOOK.matchAll(/-f (\d{3})_[a-z0-9_]+\.sql/g)].map((m) => m[1]));
}

describe("migration runbook", () => {
  it("finds the migration files and both lists", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(preflightRows().has("001")).toBe(true);
    expect(applyLines().has("048")).toBe(true);
  });

  it("every migration file has a pre-flight row, or an entry saying why not", () => {
    const rows = preflightRows();
    expect(FILES.map(num).filter((n) => !rows.has(n) && !(n in NO_PREFLIGHT_ROW))).toEqual([]);
  });

  it("every migration file from 048 on has an apply line, or an entry saying why not", () => {
    const lines = applyLines();
    expect(FILES.map(num).filter((n) => n >= "048" && !lines.has(n) && !(n in NO_APPLY_LINE))).toEqual([]);
  });

  it("every pre-flight row and apply line names a file that exists", () => {
    const present = new Set(FILES.map(num));
    expect([...preflightRows(), ...applyLines()].filter((n) => !present.has(n))).toEqual([]);
  });

  it("the exemptions name files that exist and are still missing from the list", () => {
    const present = new Set(FILES.map(num));
    const rows = preflightRows();
    const lines = applyLines();
    expect(Object.keys(NO_PREFLIGHT_ROW).filter((n) => !present.has(n) || rows.has(n))).toEqual([]);
    expect(Object.keys(NO_APPLY_LINE).filter((n) => !present.has(n) || lines.has(n))).toEqual([]);
  });

  it("the fresh-database loop reaches every file, not only 0*.sql", () => {
    const start = RUNBOOK.indexOf("### Fresh database");
    const block = RUNBOOK.slice(start, RUNBOOK.indexOf("```\n", RUNBOOK.indexOf("```bash", start) + 7));
    expect(block).toMatch(/for f in \$\(ls \[0-9\]\*\.sql \| sort\)/);
  });
});
