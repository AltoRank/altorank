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
 * anything else in apps/web reads the table.
 *
 * Like its sibling in lib/queries/__tests__/workspace-scope-guard.test.ts it is
 * a lint rule wearing a test's clothes. It parses every source file with the
 * TypeScript compiler, so comments are comments and strings are strings (a
 * `//` inside a URL on the same line hides nothing), and it checks five things:
 *
 * - every `.from("analytics_metrics")` outside read.ts is classified by what
 *   its chain does (select / insert / update / upsert / delete) and which
 *   `source` that same unbroken chain pins, and must be in ALLOWED, as many
 *   times as ALLOWED says. A source pinned later through a `let` that is
 *   reassigned under an `if` is not in the chain, so it reads as "any source",
 *   which is never allowable;
 * - an allowed select must page (`.range()`) or be a single row, because the
 *   GA4 and Bing reads are summed too, and the cap cuts them the same way;
 * - any other string or template literal containing "analytics_metrics" is a
 *   finding: the name in a variable, a raw PostgREST URL, a SQL string. A
 *   name built by concatenating two halves is the one spelling this cannot
 *   see; nobody writes that by accident;
 * - a `readGsc` call that asks for more than one shape must be in
 *   MULTI_SHAPE, with the reason. Types keep a partition from being passed
 *   under another shape's name (analysis.ts, `Shaped`), but nothing in
 *   TypeScript stops a caller holding two partitions from adding them up. So
 *   every caller that holds two is listed, where a reviewer sees it. Importing
 *   readGsc under another name is a finding, so the rule cannot be renamed
 *   around;
 * - no migration reads the table in SQL. A view or function that sums it,
 *   called through `.rpc()` or `.from("<view>")`, would get past every rule
 *   above, so supabase/migrations is read too, and only DDL on the table
 *   itself (create/alter/drop, indexes, policies, comments, grants) may name
 *   it.
 *
 * An entry that stops matching fails too: the lists cannot rot into a pile of
 * stale excuses.
 *
 * Tests are not walked. They build the table's rows for fakes and seed the
 * local database; the invariant is about what the product reads.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const TABLE = "analytics_metrics";
const READER = "lib/gsc/read.ts";

/**
 * Key is `path:operation:source`; `n` is how many such calls the file has,
 * and `why` is why they may stay. `source` is the value of the chain's
 * `.eq("source", …)`, or `any` when it pins none - which is what an insert
 * looks like, since its source is in the rows it writes. A second GA4 read in
 * the report would make the count 2 and fail, rather than hide behind the
 * first one's reason.
 */
const ALLOWED: Record<string, { n: number; why: string }> = {
  "lib/google/sync.ts:delete:gsc": {
    n: 1,
    why: "the nightly sync clears a day's Search Console rows before writing it again; a writer, not a read",
  },
  "lib/google/sync.ts:delete:ga4": { n: 1, why: "the same, for the day's GA4 rows" },
  "lib/google/sync.ts:insert:any": {
    n: 2,
    why: "the sync's two inserts: GA4 rows, and the Search Console rows gscRowsForDay (lib/gsc/rows.ts) shapes",
  },
  "lib/bing/sync.ts:delete:bing": { n: 1, why: "Bing's sync replaces its window before writing it; Bing is not Search Console" },
  "lib/bing/sync.ts:insert:any": { n: 1, why: "Bing's daily rows (source 'bing'); not Search Console" },
  "lib/queries/bing.ts:select:bing": {
    n: 1,
    why: "the dashboard's Bing line reads source 'bing' only, kept apart from Google's numbers on purpose; paged",
  },
  "lib/reports/metrics.ts:select:ga4": {
    n: 1,
    why: "the client report's GA4 block reads source 'ga4' only, paged; its Search Console block goes through readGsc",
  },
};

/**
 * Callers of readGsc that hold more than one shape at once, keyed by
 * `path:shapes` (the literal list joined with "+", or the expression's text
 * when it is not a literal). Each one is a place where two partitions could be
 * added together, so each says what it does with them instead.
 */
const MULTI_SHAPE: Record<string, string> = {
  "lib/gsc/queries.ts:ROW_SHAPES":
    "the dashboard's one read of every shape; each partition goes to the analysis function that reads it " +
    "(lib/gsc/analysis.ts), and windowMeasured counts days, not clicks, across them",
  "lib/reports/metrics.ts:total+query":
    "the client report: periodTotals reads totals with the query-row fallback for days before totals existed, " +
    "and the organic value prices the query rows alone",
};

/** Directories skipped wherever they are: dependencies, build output, tests. */
const SKIP_ANYWHERE = new Set(["node_modules", "__tests__"]);
/**
 * Directories skipped only at apps/web's root, where they mean something else:
 * `supabase` (SQL, read separately below), `e2e` (Playwright specs), `public`
 * (static files) and `coverage` (vitest output). Deeper down the same names
 * are product code - app/api/agent/v1/gsc/coverage, lib/supabase, lib/e2e -
 * and a skip by bare name once left all three unread.
 */
const SKIP_AT_ROOT = new Set(["supabase", "e2e", "public", "coverage"]);

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Dot-directories are tooling and build output (.next, .open-next, .turbo).
    if (entry.startsWith(".") || SKIP_ANYWHERE.has(entry)) continue;
    if (dir === ROOT && SKIP_AT_ROOT.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

/** `table`: a use of the table, checked against ALLOWED. `shapes`: a readGsc call, checked against MULTI_SHAPE. */
type Finding = { kind: "table" | "shapes"; key: string; file: string; line: number; what: string };

const OPS = ["select", "insert", "upsert", "update", "delete"] as const;

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The literal text of a string-ish node, or null. */
function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

/**
 * The calls chained onto `call`, in order, while each one is called on the
 * result of the last: `.from(t).select(c).eq(a, b)` gives select and eq. It
 * stops at anything else (an assignment, an `await`, an argument list), which
 * is what "the unbroken chain" means above.
 */
function chainAfter(call: ts.CallExpression): Array<{ name: string; args: readonly ts.Expression[] }> {
  const out: Array<{ name: string; args: readonly ts.Expression[] }> = [];
  let cur: ts.Expression = call;
  for (;;) {
    const access = cur.parent;
    if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== cur) return out;
    const next = access.parent;
    if (!next || !ts.isCallExpression(next) || next.expression !== access) return out;
    out.push({ name: access.name.text, args: next.arguments });
    cur = next;
  }
}

/** Does this chain stop PostgREST's cap from cutting it short? */
function paged(chain: Array<{ name: string; args: readonly ts.Expression[] }>, selectArgs: readonly ts.Expression[]): boolean {
  if (chain.some((c) => c.name === "range" || c.name === "single" || c.name === "maybeSingle")) return true;
  // A head count returns no rows at all.
  const opts = selectArgs[1];
  if (opts && ts.isObjectLiteralExpression(opts)) {
    for (const p of opts.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "head" && p.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    }
  }
  // A limit the cap cannot cut: at most 1,000, written as a number.
  const limit = chain.find((c) => c.name === "limit")?.args[0];
  return !!limit && ts.isNumericLiteral(limit) && Number(limit.text) <= 1000;
}

/** Every mention of the table, and every readGsc call, in one file's code. Pure, so it is tested below. */
function scan(rel: string, src: string): Finding[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const found: Finding[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const tableMention = (node: ts.Node) => {
    const line = lineOf(node);
    const text = literalText(node);
    const call = node.parent;
    const isFrom =
      text === TABLE &&
      call !== undefined &&
      ts.isCallExpression(call) &&
      call.arguments[0] === node &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "from";
    if (!isFrom) {
      // The table's name held in a variable, passed along, or built into a
      // URL or a SQL string: the `.from(` rule cannot see where it goes.
      found.push({ kind: "table", key: `${rel}:name`, file: rel, line, what: `names "${TABLE}" outside a .from() call` });
      return;
    }
    const chain = chainAfter(call as ts.CallExpression);
    const opCall = chain.find((c) => (OPS as readonly string[]).includes(c.name));
    const op = opCall?.name ?? "unknown";
    const pin = chain.find((c) => c.name === "eq" && literalText(c.args[0]) === "source");
    const source = (pin && literalText(pin.args[1])) || "any";
    if (op === "select" && !paged(chain, opCall!.args)) {
      found.push({
        kind: "table",
        key: `${rel}:select-unpaged:${source}`,
        file: rel,
        line,
        what: `reads "${TABLE}" (source ${source}) without .range(): PostgREST stops at 1,000 rows and says nothing`,
      });
      return;
    }
    found.push({
      kind: "table",
      key: `${rel}:${op}:${source}`,
      file: rel,
      line,
      what: op === "select" ? `reads "${TABLE}" (source ${source})` : `${op} on "${TABLE}" (source ${source})`,
    });
  };

  const readGscCall = (call: ts.CallExpression) => {
    const opts = call.arguments[1];
    let shapes: string | null = null;
    if (opts && ts.isObjectLiteralExpression(opts)) {
      const prop = opts.properties.find((p) => p.name?.getText(sf) === "shapes");
      if (prop && ts.isShorthandPropertyAssignment(prop)) shapes = prop.name.text;
      else if (prop && ts.isPropertyAssignment(prop)) {
        const v = prop.initializer;
        const items = ts.isArrayLiteralExpression(v) ? v.elements.map((e) => literalText(e)) : null;
        if (items && items.every((i) => i !== null)) {
          if (new Set(items).size <= 1) return;
          shapes = (items as string[]).join("+");
        } else {
          shapes = v.getText(sf).replace(/\s+/g, " ");
        }
      }
    }
    shapes ??= opts ? opts.getText(sf).replace(/\s+/g, " ") : "none";
    found.push({
      kind: "shapes",
      key: `${rel}:${shapes}`,
      file: rel,
      line: lineOf(call),
      what: `readGsc reads more than one shape (${shapes}); holding two partitions is where they get added together`,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (node.text.includes(TABLE)) tableMention(node);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "readGsc") {
      readGscCall(node);
    } else if (ts.isImportSpecifier(node) && node.propertyName?.text === "readGsc" && node.name.text !== "readGsc") {
      found.push({ kind: "shapes", key: `${rel}:alias`, file: rel, line: lineOf(node), what: `imports readGsc as "${node.name.text}"` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * DDL on the table itself: the statements a migration writes to create the
 * table, change its columns, index it and put policies on it. A statement
 * that is anything else and names the table reads it (a view, a function, a
 * DO block, a one-off update).
 */
const TABLE_DDL = /^(create\s+table|alter\s+table|drop\s+table|create\s+(unique\s+)?index|drop\s+index|(create|alter|drop)\s+policy|comment\s+on|grant|revoke)\b/i;

/** Statements of a migration, with comments removed and dollar-quoted bodies kept whole. */
function sqlStatements(sql: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf = "";
  let line = 1;
  let startLine = 1;
  let i = 0;
  const push = () => {
    if (buf.trim()) out.push({ text: buf.trim(), line: startLine });
    buf = "";
  };
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (!buf.trim()) startLine = line;
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    const dollar = rest.match(/^\$[A-Za-z_]*\$/);
    const quote = rest[0] === "'" ? "'" : null;
    if (dollar || quote) {
      const tag = dollar ? dollar[0] : "'";
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      const chunk = sql.slice(i, stop);
      line += (chunk.match(/\n/g) ?? []).length;
      buf += chunk;
      i = stop;
      continue;
    }
    if (sql[i] === ";") {
      push();
      i++;
      continue;
    }
    if (sql[i] === "\n") line++;
    buf += sql[i];
    i++;
  }
  push();
  return out;
}

/** Every statement in one migration that names the table and is not DDL on it. Pure, so it is tested below. */
function scanSql(rel: string, sql: string): Finding[] {
  const found: Finding[] = [];
  for (const s of sqlStatements(sql)) {
    if (!new RegExp(`\\b${TABLE}\\b`, "i").test(s.text)) continue;
    if (TABLE_DDL.test(s.text) && !/\$[A-Za-z_]*\$/.test(s.text)) continue;
    found.push({ kind: "table", key: `${rel}:sql`, file: rel, line: s.line, what: `names "${TABLE}" in SQL that is not DDL on it: ${s.text.split("\n")[0].slice(0, 80)}` });
  }
  return found;
}

function findAll(): { findings: Finding[]; readerHits: number; files: string[] } {
  const findings: Finding[] = [];
  let readerHits = 0;
  const files: string[] = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    files.push(rel);
    const hits = scan(rel, readFileSync(file, "utf8"));
    if (rel === READER) {
      // Its own reads are the point; anything else it did would still count.
      const own = (h: Finding) => h.kind === "table" && !h.key.endsWith(":name");
      readerHits += hits.filter(own).length;
      findings.push(...hits.filter((h) => !own(h)));
      continue;
    }
    findings.push(...hits);
  }
  for (const entry of readdirSync(MIGRATIONS)) {
    if (!entry.endsWith(".sql")) continue;
    const rel = `supabase/migrations/${entry}`;
    files.push(rel);
    findings.push(...scanSql(rel, readFileSync(join(MIGRATIONS, entry), "utf8")));
  }
  return { findings, readerHits, files };
}

const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());

describe("Search Console is read through lib/gsc/read.ts only", () => {
  const { findings, readerHits, files } = findAll();

  it("finds the reader itself, so the walk is looking in the right place", () => {
    // readGsc, latestGscDate and lastGscWriteAt. If this reads 0, the walk
    // moved or the scanner broke, and the next tests would pass on nothing.
    expect(readerHits).toBeGreaterThanOrEqual(3);
  });

  it("walks the product directories whose names are also skipped names at the root", () => {
    // A skip by bare name once left these unread; any Search Console read in
    // them passed.
    for (const f of [
      "app/api/agent/v1/gsc/coverage/route.ts",
      "lib/supabase/server.ts",
      "lib/e2e/stubs.ts",
      "lib/gsc/queries.ts",
      "scripts/validate-picks.ts",
      "supabase/migrations/006_analytics_metrics.sql",
    ]) {
      expect(files, f).toContain(f);
    }
    expect(files.some((f) => f.startsWith("e2e/") || f.includes("/__tests__/") || f.startsWith("node_modules/"))).toBe(false);
  });

  it("no other file reads the table, except the writers and the GA4/Bing readers allowed below", () => {
    const tableFindings = findings.filter((f) => f.kind === "table");
    const seen = count(tableFindings.map((f) => f.key));
    const unexplained = tableFindings.filter((f) => !(f.key in ALLOWED) || seen.get(f.key)! > ALLOWED[f.key].n);
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
            `Freshness: latestGscDate() / lastGscWriteAt(). Not in SQL: no view or function.\n\n` +
            `A GA4 or Bing read, or a writer, belongs in ALLOWED in this file with the\n` +
            `reason and the count. Pin the source in the same chain with\n` +
            `.eq("source", "ga4"|"bing"), and page a read with readAllPages\n` +
            `(lib/supabase/read-all.ts).\n`,
    ).toBe(0);
  });

  it("every readGsc call that holds more than one shape says why", () => {
    const unexplained = findings.filter((f) => f.kind === "shapes" && !(f.key in MULTI_SHAPE));
    expect(
      unexplained.length,
      unexplained.length === 0
        ? ""
        : `\n${unexplained.map((f) => `  ${f.file}:${f.line} ${f.what}`).join("\n")}\n\n` +
            `Every click is in every shape, so two partitions added together double it. Read\n` +
            `one shape per call where you can. Where one read really needs two, add it to\n` +
            `MULTI_SHAPE in this file with what each partition is used for.\n`,
    ).toBe(0);
  });

  it("every allowance still corresponds to real code, as many times as it says", () => {
    const seen = count(findings.map((f) => f.key));
    const stale = [
      ...Object.entries(ALLOWED)
        .filter(([k, v]) => (seen.get(k) ?? 0) !== v.n)
        .map(([k, v]) => `${k} (allowed ${v.n}, found ${seen.get(k) ?? 0})`),
      ...Object.keys(MULTI_SHAPE).filter((k) => !seen.has(k)),
    ];
    expect(
      stale.length,
      stale.length === 0
        ? ""
        : `\nThese entries no longer match the code:\n` +
            stale.map((s) => `  ${s}`).join("\n") +
            `\n\nThe code moved, went away or changed count. Fix the entry.\n`,
    ).toBe(0);
    // An unpaged read is never allowable, so it can never be listed.
    expect(Object.keys(ALLOWED).filter((k) => k.includes("unpaged"))).toEqual([]);
  });
});

describe("the scanner", () => {
  // The guard is only as good as what it can see. These pin the shapes of the
  // mistakes it exists for, so a change cannot quietly blind it.
  const keys = (src: string) => scan("lib/x.ts", src).map((f) => f.key);

  it("flags a Search Console read, however it is filtered", () => {
    expect(keys(`await db.from("analytics_metrics").select("clicks").eq("source", "gsc").not("query", "is", null).range(0, 999);`)).toEqual([
      "lib/x.ts:select:gsc",
    ]);
  });

  it("flags a read with no source filter as a read of every source", () => {
    expect(keys(`const { data } = await supabase\n  .from('analytics_metrics')\n  .select("*")\n  .eq("workspace_id", id)\n  .range(0, 999);`)).toEqual([
      "lib/x.ts:select:any",
    ]);
  });

  it("flags a read without paging as unpaged, whatever its source", () => {
    expect(keys(`await db.from("analytics_metrics").select("pageviews").eq("source", "ga4");`)).toEqual(["lib/x.ts:select-unpaged:ga4"]);
    expect(keys(`await db.from("analytics_metrics").select("pageviews").eq("source", "ga4").limit(5000);`)).toEqual([
      "lib/x.ts:select-unpaged:ga4",
    ]);
    expect(keys(`await db.from("analytics_metrics").select("id", { count: "exact", head: true }).eq("source", "ga4");`)).toEqual([
      "lib/x.ts:select:ga4",
    ]);
  });

  it("tells a GA4 read from a writer, and each from the chain after it only", () => {
    const src = [
      `await supabase.from("analytics_metrics").delete().eq("workspace_id", w).eq("source", "gsc");`,
      `await supabase.from("analytics_metrics").insert(rows);`,
      `const { data } = await supabase.from("analytics_metrics").select("pageviews").eq("source", "ga4").range(0, 999);`,
    ].join("\n");
    expect(keys(src)).toEqual(["lib/x.ts:delete:gsc", "lib/x.ts:insert:any", "lib/x.ts:select:ga4"]);
  });

  it("reads a source pinned later under an if as no pin at all", () => {
    // In an allowlisted file this used to pass as a GA4 read while summing
    // every source whenever the condition was false.
    const src = `let q = db.from("analytics_metrics").select("clicks").eq("workspace_id", w).range(0, 999);\nif (gaOnly) q = q.eq("source", "ga4");`;
    expect(keys(src)).toEqual(["lib/x.ts:select:any"]);
  });

  it("flags the table's name held in a variable, a REST URL or a SQL string", () => {
    expect(keys(`const TABLE = "analytics_metrics";\nawait db.from(TABLE).select("clicks");`)).toEqual(["lib/x.ts:name"]);
    expect(keys("await fetch(`${base}/rest/v1/analytics_metrics?select=clicks`);")).toEqual(["lib/x.ts:name"]);
    expect(keys(`const q = "select sum(clicks) from analytics_metrics where source = 'gsc'";`)).toEqual(["lib/x.ts:name"]);
  });

  it("is not blinded by a // inside a string on the same line", () => {
    const src = `const ref = "https://search.google.com"; const { data } = await db.from("analytics_metrics").select("clicks").eq("workspace_id", ws);`;
    expect(keys(src)).toEqual(["lib/x.ts:select-unpaged:any"]);
  });

  it("ignores the table named in a comment", () => {
    expect(keys(`// reads \`analytics_metrics\` nightly\n/**\n * the "analytics_metrics" table\n */\nconst x = 1; // "analytics_metrics"\n/* "analytics_metrics" */ const y = 2;`)).toEqual([]);
  });

  it("flags a readGsc call holding more than one shape, and passes one holding one", () => {
    expect(keys(`await readGsc(db, { workspaceId, shapes: ["query"], since, columns: ["clicks"] });`)).toEqual([]);
    expect(keys(`await readGsc(db, { workspaceId, shapes: ["query", "query_page"], since, columns: ["clicks"] });`)).toEqual([
      "lib/x.ts:query+query_page",
    ]);
    expect(keys(`await readGsc(db, { workspaceId, shapes: ROW_SHAPES, since, columns: [] });`)).toEqual(["lib/x.ts:ROW_SHAPES"]);
  });

  it("flags readGsc imported under another name", () => {
    expect(keys(`import { readGsc as read } from "@/lib/gsc/read";`)).toEqual(["lib/x.ts:alias"]);
  });

  describe("in SQL", () => {
    const sqlKeys = (sql: string) => scanSql("supabase/migrations/999_x.sql", sql).map((f) => f.key);

    it("lets DDL on the table through", () => {
      const ddl = [
        `-- reads analytics_metrics? no, a comment`,
        `CREATE TABLE analytics_metrics (id uuid PRIMARY KEY);`,
        `CREATE INDEX idx_analytics_metrics_workspace ON analytics_metrics(workspace_id, metric_date);`,
        `ALTER TABLE analytics_metrics ADD CONSTRAINT analytics_metrics_source_check CHECK (source IN ('ga4', 'gsc', 'bing'));`,
        `COMMENT ON COLUMN analytics_metrics.source IS 'ga4 | gsc | bing; a ; in a string';`,
        `alter table analytics_metrics enable row level security;`,
        `create policy "Analytics by access" on analytics_metrics for all using (workspace_id in (select user_workspace_ids()));`,
      ].join("\n");
      expect(sqlKeys(ddl)).toEqual([]);
    });

    it("flags a function or a view that reads it", () => {
      const fn = `create or replace function gsc_clicks(ws uuid) returns bigint language sql as $$\n  select sum(clicks) from analytics_metrics where workspace_id = ws and source = 'gsc';\n$$;`;
      const view = `create view gsc_daily as select metric_date, sum(clicks) from public.analytics_metrics group by 1;`;
      expect(sqlKeys(`${fn}\n${view}`)).toEqual(["supabase/migrations/999_x.sql:sql", "supabase/migrations/999_x.sql:sql"]);
    });

    it("flags a function body that names it even behind a DDL-looking start", () => {
      const doBlock = `do $body$ begin\n  delete from analytics_metrics where source = 'gsc';\nend $body$;`;
      expect(sqlKeys(doBlock)).toEqual(["supabase/migrations/999_x.sql:sql"]);
    });
  });
});
