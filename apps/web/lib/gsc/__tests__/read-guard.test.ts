/**
 * No Search Console read outside lib/gsc/read.ts.
 *
 * `analytics_metrics` holds Search Console in four row shapes a day, and the
 * same click is in each one. Every reader used to write its own shape filter,
 * and the same mistake kept shipping: a filter that let a second shape through
 * (`.not("query", "is", null)` also matches query_page rows), or no filter at
 * all, and a total two or four times the truth in front of a client. The fix
 * for that class is structural: one reader (lib/gsc/read.ts) that partitions
 * by shape and pages past the 1,000-row cap, and this test, which fails when
 * any other file in apps/web can so much as name the table in a read.
 *
 * Like its sibling in lib/queries/__tests__/workspace-scope-guard.test.ts it is
 * a lint rule wearing a test's clothes. It reads source as text:
 *
 * - every `.from("analytics_metrics")` outside read.ts is classified by what
 *   the chain after it does (select / insert / update / upsert / delete) and
 *   which `source` it pins, and must be in ALLOWED;
 * - every other quoted "analytics_metrics" in code (not in a comment) is a
 *   finding too, so `const T = "analytics_metrics"; db.from(T)` cannot walk
 *   around the first rule.
 *
 * ALLOWED is for the writers and the two sources that are not Search Console.
 * A read with no `source` filter reads Search Console rows along with the
 * rest, so it is never allowable. An entry that stops matching fails too: the
 * list cannot rot into a pile of stale excuses.
 *
 * Tests are not walked. They build the table's rows for fakes and seed the
 * local database; the invariant is about what the product reads.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TABLE = "analytics_metrics";
const READER = "lib/gsc/read.ts";

/**
 * Key is `path:operation:source`; value is why it may stay. `source` is the
 * value of the chain's `.eq("source", …)`, or `any` when it pins none - which
 * is what an insert looks like, since its source is in the rows it writes.
 */
const ALLOWED: Record<string, string> = {
  "lib/google/sync.ts:delete:gsc":
    "the nightly sync clears a day's Search Console rows before writing it again; a writer, not a read",
  "lib/google/sync.ts:delete:ga4": "the same, for the day's GA4 rows",
  "lib/google/sync.ts:insert:any":
    "the sync's two inserts: GA4 rows, and the Search Console rows gscRowsForDay (lib/gsc/rows.ts) shapes",
  "lib/bing/sync.ts:delete:bing": "Bing's sync replaces its window before writing it; Bing is not Search Console",
  "lib/bing/sync.ts:insert:any": "Bing's daily rows (source 'bing'); not Search Console",
  "lib/queries/bing.ts:select:bing":
    "the dashboard's Bing line reads source 'bing' only, kept apart from Google's numbers on purpose",
  "lib/reports/metrics.ts:select:ga4":
    "the client report's GA4 block reads source 'ga4' only; its Search Console block goes through readGsc",
};

const ROOT = join(__dirname, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "coverage", "__tests__", "e2e", "supabase"]);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

type Finding = { key: string; file: string; line: number; what: string };

/** How much text after `.from(` counts as its chain: the scope guard's rule. */
const CHAIN_LINES = 22;
const OPS = ["select", "insert", "upsert", "update", "delete"] as const;

/** Every mention of the table in one file's code, classified. Pure, so it is tested below. */
function scan(rel: string, src: string): Finding[] {
  const found: Finding[] = [];
  for (const m of src.matchAll(new RegExp(`(["'\`])${TABLE}\\1`, "g"))) {
    const at = m.index!;
    const lineStart = src.lastIndexOf("\n", at) + 1;
    const before = src.slice(lineStart, at);
    // A comment is prose about the table, not a use of it.
    const trimmed = before.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || before.includes("//")) continue;
    const line = src.slice(0, at).split("\n").length;

    const isFrom = /\.from\(\s*$/.test(src.slice(Math.max(0, at - 40), at));
    if (!isFrom) {
      // The table's name held in a variable, passed along, or built into a
      // query some other way: the `.from(` rule cannot see where it goes.
      found.push({ key: `${rel}:name`, file: rel, line, what: `names "${TABLE}" outside a .from() call` });
      continue;
    }

    let chain = src
      .slice(at + m[0].length)
      .split("\n")
      .slice(0, CHAIN_LINES)
      .join("\n");
    const next = chain.indexOf(".from(");
    if (next !== -1) chain = chain.slice(0, next);

    let op = "unknown";
    let first = Infinity;
    for (const candidate of OPS) {
      const i = chain.indexOf(`.${candidate}(`);
      if (i !== -1 && i < first) {
        first = i;
        op = candidate;
      }
    }
    const source = chain.match(/\.eq\(\s*["'`]source["'`]\s*,\s*["'`](\w+)["'`]/)?.[1] ?? "any";
    found.push({
      key: `${rel}:${op}:${source}`,
      file: rel,
      line,
      what: op === "select" ? `reads "${TABLE}" (source ${source})` : `${op} on "${TABLE}" (source ${source})`,
    });
  }
  return found;
}

function findAll(): { findings: Finding[]; readerHits: number } {
  const findings: Finding[] = [];
  let readerHits = 0;
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const src = readFileSync(file, "utf8");
    const hits = scan(rel, src);
    if (rel === READER) {
      readerHits += hits.length;
      continue;
    }
    findings.push(...hits);
  }
  return { findings, readerHits };
}

describe("Search Console is read through lib/gsc/read.ts only", () => {
  const { findings, readerHits } = findAll();

  it("finds the reader itself, so the walk is looking in the right place", () => {
    // readGsc, latestGscDate and lastGscWriteAt. If this reads 0, the walk
    // moved or the scanner broke, and the next two tests would pass on
    // nothing.
    expect(readerHits).toBeGreaterThanOrEqual(3);
  });

  it("no other file reads the table, except the writers and the GA4/Bing readers allowed below", () => {
    const unexplained = findings.filter((f) => !(f.key in ALLOWED));
    const detail = unexplained.map((f) => `  ${f.file}:${f.line} ${f.what}`).join("\n");
    expect(
      unexplained.length,
      unexplained.length === 0
        ? ""
        : `\n${detail}\n\n` +
            `analytics_metrics holds Search Console in four row shapes a day (total, query,\n` +
            `page, query_page) and every click is in each of them, so a hand-written filter\n` +
            `that lets a second shape through doubles the number, and no filter quadruples it.\n` +
            `PostgREST also stops at 1,000 rows without saying so.\n\n` +
            `Read Search Console with readGsc() from lib/gsc/read.ts: name the shapes you\n` +
            `want and read the partition you asked for; it pages past the cap for you.\n` +
            `Freshness: latestGscDate() / lastGscWriteAt().\n\n` +
            `A GA4 or Bing read, or a writer, belongs in ALLOWED in this file with the\n` +
            `reason. Pin the source with .eq("source", "ga4"|"bing") so the key says which.\n`,
    ).toBe(0);
  });

  it("every allowance still corresponds to real code", () => {
    const live = new Set(findings.map((f) => f.key));
    const stale = Object.keys(ALLOWED).filter((k) => !live.has(k));
    expect(
      stale.length,
      stale.length === 0
        ? ""
        : `\nThese ALLOWED entries no longer match anything:\n` +
            stale.map((s) => `  ${s}`).join("\n") +
            `\n\nThe code moved or went away. Delete the entry.\n`,
    ).toBe(0);
  });
});

describe("the scanner", () => {
  // The guard is only as good as what it can see. These pin the shapes of the
  // mistakes it exists for, so a regex change cannot quietly blind it.
  const keys = (src: string) => scan("lib/x.ts", src).map((f) => f.key);

  it("flags a Search Console read, however it is filtered", () => {
    expect(keys(`await db.from("analytics_metrics").select("clicks").eq("source", "gsc").not("query", "is", null);`)).toEqual([
      "lib/x.ts:select:gsc",
    ]);
  });

  it("flags a read with no source filter as a read of every source", () => {
    expect(keys(`const { data } = await supabase\n  .from('analytics_metrics')\n  .select("*")\n  .eq("workspace_id", id);`)).toEqual([
      "lib/x.ts:select:any",
    ]);
  });

  it("tells a GA4 read from a writer, and each from the chain after it only", () => {
    const src = [
      `await supabase.from("analytics_metrics").delete().eq("workspace_id", w).eq("source", "gsc");`,
      `await supabase.from("analytics_metrics").insert(rows);`,
      `const { data } = await supabase.from("analytics_metrics").select("pageviews").eq("source", "ga4");`,
    ].join("\n");
    expect(keys(src)).toEqual(["lib/x.ts:delete:gsc", "lib/x.ts:insert:any", "lib/x.ts:select:ga4"]);
  });

  it("flags the table's name held in a variable", () => {
    expect(keys(`const TABLE = "analytics_metrics";\nawait db.from(TABLE).select("clicks");`)).toEqual(["lib/x.ts:name"]);
  });

  it("ignores the table named in a comment", () => {
    expect(keys(`// reads \`analytics_metrics\` nightly\n/**\n * the "analytics_metrics" table\n */\nconst x = 1; // "analytics_metrics"`)).toEqual([]);
  });
});
