/**
 * No read of an article's text through a client token.
 *
 * Migration 097 withholds the body columns (lib/articles/body-read.ts,
 * ARTICLE_BODY_COLUMNS) from `anon` and `authenticated`, so a query through
 * the signed-in person's client that names one of them - or `*`, which names
 * all of them - is refused by the database with "permission denied for table
 * articles". That refusal is the lock that stops an account before its trial
 * from reading a draft straight out of /rest/v1 (2026-09-22). It also means
 * such a query in the app is a page that errors for every paying customer.
 *
 * So this walks the source, finds every `.from("articles")` query that asks
 * for a body column, and fails unless the query is one of the reads below:
 * all of them run on the service role, where the columns still answer. A new
 * read of the text belongs in lib/billing/body-lock.ts (a signed-in caller,
 * after the trial gate) or lib/articles/body-read.ts (the server's own read),
 * not here.
 *
 * Crude on purpose, like lib/queries/__tests__/workspace-scope-guard.test.ts:
 * it reads each query as text, up to the end of its statement. An entry is a
 * file and how many such queries it holds, so a second one added to a file
 * that already has one still trips it, and an entry that stops matching
 * fails too.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ARTICLE_BODY_COLUMNS } from "../body-read";

const ROOT = join(__dirname, "..", "..", "..");
const SEARCH_DIRS = ["app", "lib", "components"];

/** Reads of the body through the service role: file -> how many, and why that client. */
const SERVICE_READS: Record<string, { count: number; why: string }> = {
  "app/actions/exchange.ts": {
    count: 1,
    why: "the backlink exchange inserts its citation into the draft it just generated, with the admin client it generated it with",
  },
  "app/api/agent/v1/articles/generate/route.ts": {
    count: 1,
    why: "the agent API runs on the service client (lib/agent/auth.ts); the insert hands back the new row, and the route asks the trial gate before it returns any text",
  },
  "app/api/blog/v1/articles/[slug]/route.ts": {
    count: 1,
    why: "the headless blog API runs on the service client (lib/blog-api/auth.ts) and serves only `live` articles, which are published and public already",
  },
  "app/api/blog/v1/articles/route.ts": {
    count: 1,
    why: "the headless blog API's list, on the service client; its column list is a constant from lib/blog-api/auth.ts, which this cannot follow across files",
  },
  "lib/articles/body-read.ts": {
    count: 1,
    why: "readArticlesWhole: the server's one read of the text, on the service role, for ids a caller's own client returned",
  },
  "lib/agent/data.ts": {
    count: 2,
    why: "the agent API's reads run on the service client, scoped to the key's account; the content routes ask the trial gate (lib/agent/body-lock.ts)",
  },
  "lib/content/generate.ts": {
    count: 1,
    why: "articleHasText: whether a draft target has text, a filter on content that returns only the id, on the counting client (the service role); the text itself is never read",
  },
  "lib/found-on-site/detect.ts": {
    count: 2,
    why: "the found-on-site check runs inside cron/site-pages on the service client: it filters drafts on having text, then compares that text with pages on the customer's site",
  },
  "lib/publishing/auto-approve.ts": {
    count: 1,
    why: "the auto-approve pass runs inside cron/publish on the service client and reads the text to run the same checks a person would",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** The query from `.from("articles")` to the end of its statement: the first `;` or `,` outside brackets. */
function statementAt(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return src.slice(start, i);
    } else if ((c === ";" || c === ",") && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}

const BODY = new Set<string>(ARTICLE_BODY_COLUMNS);

/**
 * The select list a `.select(...)` argument names: the string itself, or the
 * string a constant of that name holds in the same file.
 */
function selectList(arg: string, src: string): string | null {
  const literal = arg.match(/^["'`]([\s\S]*?)["'`]/)?.[1];
  if (literal !== undefined) return literal;
  const name = arg.match(/^([A-Z_a-z]\w*)/)?.[1];
  if (!name) return null;
  return src.match(new RegExp(`\\b${name}\\s*=\\s*["'\`]([\\s\\S]*?)["'\`]`))?.[1] ?? null;
}

/** True when the query selects `*` or a body column, or filters on one. */
function readsBody(chain: string, src: string = chain): boolean {
  for (const m of chain.matchAll(/\.select\(/g)) {
    // The argument up to its own closing bracket: an embedded resource,
    // `workspaces(domain)`, has brackets of its own.
    const open = m.index! + m[0].length;
    let depth = 1;
    let end = open;
    while (end < chain.length && depth > 0) {
      if (chain[end] === "(") depth++;
      else if (chain[end] === ")") depth--;
      end++;
    }
    const arg = chain.slice(open, end - 1).trim();
    // `.select()` after an insert or an update is `*`.
    if (!arg) return true;
    const list = selectList(arg, src);
    // A list this cannot resolve (built at runtime) cannot be checked. It is
    // reported, so that whoever wrote it says here which client runs it.
    if (list === null) return true;
    const columns = list.split(",").map((c) => c.trim().split(/[\s:(]/)[0]);
    if (columns.some((c) => c === "*" || BODY.has(c))) return true;
  }
  for (const m of chain.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|like|ilike|is|not|in|contains|containedBy|filter|order|textSearch)\(\s*["'`](\w+)/g)) {
    if (BODY.has(m[1])) return true;
  }
  return false;
}

function findBodyReads(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const dir of SEARCH_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      for (const m of src.matchAll(/\.from\(\s*["'`]articles["'`]\s*\)/g)) {
        if (!readsBody(statementAt(src, m.index!), src)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        found.set(rel, [...(found.get(rel) ?? []), line]);
      }
    }
  }
  return found;
}

describe("the article text is read on the server only", () => {
  const found = findBodyReads();

  it("every query that names a body column is a service-role read we listed", () => {
    const unexplained = [...found.entries()].filter(([file, lines]) => SERVICE_READS[file]?.count !== lines.length);
    const detail = unexplained
      .map(([file, lines]) => `  ${file}:${lines.join(",")} (${lines.length} found, ${SERVICE_READS[file]?.count ?? 0} listed)`)
      .join("\n");
    expect(
      unexplained.length,
      unexplained.length === 0
        ? ""
        : `\n${detail}\n\n` +
            `These query articles for ${ARTICLE_BODY_COLUMNS.join(", ")} or "*". Migration 097 refuses\n` +
            `that to every client token, so through the signed-in person's client it is an\n` +
            `error for every customer - and before 097 it was how an account that had not\n` +
            `started its trial read the text straight from the database.\n\n` +
            `Select the columns you need by name, and read the text through\n` +
            `articlesForSession / articleBodyForSession (lib/billing/body-lock.ts), which ask\n` +
            `the trial gate, or readArticlesWhole (lib/articles/body-read.ts) for the\n` +
            `server's own work. If this really is a service-role read, list it above with why.\n`,
    ).toBe(0);
  });

  it("every listed read still exists", () => {
    const stale = Object.keys(SERVICE_READS).filter((f) => !found.has(f));
    expect(stale, `No longer read the body; delete the entry:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("finds the reads it is meant to find", () => {
    // Without this, a regex that stopped matching anything would pass the two
    // tests above by finding nothing at all.
    expect(readsBody(`.from("articles").select("*").eq("id", id)`)).toBe(true);
    expect(readsBody(`.from("articles").select("id, content").eq("id", id)`)).toBe(true);
    expect(readsBody(`.from("articles").select(\`\${COLS}, meta_description\`)`)).toBe(true);
    expect(readsBody(`.from("articles").insert(row).select()`)).toBe(true);
    expect(readsBody(`.from("articles").select("id").not("content", "is", null)`)).toBe(true);
    expect(readsBody(`.from("articles").select("id, title, word_count").eq("workspace_id", ws)`)).toBe(false);
    expect(readsBody(`.from("articles").select("id", { count: "exact", head: true })`)).toBe(false);
    expect(readsBody(`.from("articles").select(COLS)`, `const COLS = "id, title";`)).toBe(false);
    expect(readsBody(`.from("articles").select("id, workspaces(domain, account_id)").eq("id", id)`)).toBe(false);
    expect(readsBody(`.from("articles").select(COLS)`, `const COLS = "id, fact_checks";`)).toBe(true);
    expect(found.size).toBeGreaterThan(0);
  });
});
