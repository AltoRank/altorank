// An in-memory stand-in for the PostgREST builder, for the claim and resume
// tests. It applies the filters it is given rather than recording them, so a
// conditional update really does match or miss, and two callers really can
// race for one row: an update resolves after a tick, reading and writing the
// same table, the way two requests against one database do.
//
// Only what lib/plan/draft-claim.ts, lib/plan/resume-week.ts and the planner
// use: eq, neq, is, not, in, gte, lte, lt, `or` (with nested `and(...)`), order, limit,
// maybeSingle, a head count, update ... select, insert and delete. Values are
// compared as strings, which is right for the ISO dates and timestamps these
// columns hold.

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function cmp(op: string, a: unknown, b: string): boolean {
  if (op === "is") return b === "null" ? a === null || a === undefined : String(a) === b;
  if (a === null || a === undefined) return false;
  const x = String(a);
  switch (op) {
    case "eq": return x === b;
    case "neq": return x !== b;
    case "lt": return x < b;
    case "lte": return x <= b;
    case "gt": return x > b;
    case "gte": return x >= b;
    default: throw new Error(`fake-postgrest: unsupported operator ${op}`);
  }
}

/** Split on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function term(t: string): Pred {
  if (t.startsWith("and(") && t.endsWith(")")) {
    const parts = splitTop(t.slice(4, -1)).map(term);
    return (r) => parts.every((p) => p(r));
  }
  const [col, ...rest] = t.split(".");
  let negate = false;
  if (rest[0] === "not") {
    negate = true;
    rest.shift();
  }
  const op = rest.shift()!;
  const value = rest.join(".");
  return (r) => cmp(op, r[col], value) !== negate;
}

export function orFilter(expr: string): Pred {
  const parts = splitTop(expr).map(term);
  return (r) => parts.some((p) => p(r));
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every update, in order: table, the patch, and the ids it touched. */
  updates: { table: string; patch: Row; ids: unknown[] }[] = [];
  private nextId = 0;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  get client(): never {
    return { from: (table: string) => this.query(table) } as never;
  }

  private query(table: string) {
    const preds: Pred[] = [];
    const orders: Array<[string, boolean, boolean]> = [];
    let lim: number | null = null;
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let patch: Row = {};
    let insertRows: Row[] = [];
    let head = false;
    let wantCount = false;
    let single = false;

    const run = async () => {
      await tick();
      if (mode === "insert") {
        for (const r of insertRows) this.rows(table).push({ id: `id-${++this.nextId}`, ...r });
        return { data: insertRows, error: null };
      }
      let matched = this.rows(table).filter((r) => preds.every((p) => p(r)));
      if (mode === "delete") {
        this.tables[table] = this.rows(table).filter((r) => !matched.includes(r));
        return { data: null, error: null };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, patch);
        this.updates.push({ table, patch, ids: matched.map((r) => r.id) });
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      for (const [col, asc, nullsFirst] of [...orders].reverse()) {
        matched = [...matched].sort((a, b) => {
          // `nullsFirst` as PostgREST means it; without it, nulls compare as
          // the string "null", as they always have here.
          if (nullsFirst) {
            const an = a[col] === null || a[col] === undefined;
            const bn = b[col] === null || b[col] === undefined;
            if (an !== bn) return an ? -1 : 1;
          }
          return (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      if (lim !== null) matched = matched.slice(0, lim);
      const count = matched.length;
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: head ? null : matched.map((r) => ({ ...r })), count: wantCount ? count : null, error: null };
    };

    const q: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) wantCount = true;
        if (opts?.head) head = true;
        return q;
      },
      update: (p: Row) => ((mode = "update"), (patch = p), q),
      delete: () => ((mode = "delete"), q),
      insert: (r: Row | Row[]) => ((mode = "insert"), (insertRows = Array.isArray(r) ? r : [r]), q),
      eq: (c: string, v: unknown) => (preds.push((r) => cmp("eq", r[c], String(v))), q),
      neq: (c: string, v: unknown) => (preds.push((r) => cmp("neq", r[c], String(v))), q),
      gte: (c: string, v: unknown) => (preds.push((r) => cmp("gte", r[c], String(v))), q),
      lte: (c: string, v: unknown) => (preds.push((r) => cmp("lte", r[c], String(v))), q),
      lt: (c: string, v: unknown) => (preds.push((r) => cmp("lt", r[c], String(v))), q),
      is: (c: string, v: unknown) => (preds.push((r) => cmp("is", r[c], String(v))), q),
      in: (c: string, vs: unknown[]) => (preds.push((r) => vs.map(String).includes(String(r[c]))), q),
      not: (c: string, op: string, v: unknown) => (preds.push((r) => !cmp(op, r[c], String(v))), q),
      or: (expr: string) => (preds.push(orFilter(expr)), q),
      order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => (orders.push([c, o?.ascending !== false, o?.nullsFirst === true]), q),
      limit: (n: number) => ((lim = n), q),
      maybeSingle: () => ((single = true), run()),
      single: () => ((single = true), run()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return q;
  }
}
