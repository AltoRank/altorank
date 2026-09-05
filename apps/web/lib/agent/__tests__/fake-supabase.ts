/**
 * An in-memory Supabase stand-in that also takes writes.
 *
 * lib/queries/__tests__/scope-fixture.ts answers one question of a read: did
 * it filter by workspace. The agent mutation routes need more - `.update()`,
 * `.delete()`, `.insert()`, `.in()`, `.is()`, `.not()`, an inner join for
 * `articleInAgency` - and a record of every write, so a test can assert that
 * a preview wrote nothing and a remove stamped the keyword.
 *
 * Still deliberately dumb: filters are equality, joins are `alias_id` →
 * `aliases.id`, and nothing here is a database. If a test needs SQL semantics
 * it wants a real one.
 */
import { vi } from "vitest";

export type Row = Record<string, unknown>;
export type Seed = Record<string, Row[]>;

type Filter =
  | { kind: "eq" | "neq" | "gte" | "lte" | "gt" | "lt" | "ilike"; col: string; value: unknown }
  | { kind: "in"; col: string; values: unknown[] }
  | { kind: "is"; col: string; value: unknown }
  | { kind: "not-is"; col: string; value: unknown };

export type Write = { table: string; op: "update" | "delete" | "insert"; patch?: Row; rows?: Row[]; filters: Filter[] };

/** For dotted filter columns ("workspace.agency_id"): the related row, if any. */
function related(tables: Seed, row: Row, alias: string): Row | null {
  const fk = row[`${alias}_id`];
  if (fk === undefined) return null;
  const table = tables[`${alias}s`] ?? [];
  return table.find((r) => r.id === fk) ?? null;
}

function readCol(tables: Seed, row: Row, col: string): unknown {
  if (!col.includes(".")) return row[col];
  const [alias, field] = col.split(".");
  return related(tables, row, alias)?.[field];
}

function matches(tables: Seed, row: Row, f: Filter): boolean {
  const v = readCol(tables, row, f.col);
  switch (f.kind) {
    case "eq":
      return v === f.value;
    case "neq":
      return v !== f.value;
    case "gte":
      return (v as string | number) >= (f.value as string | number);
    case "lte":
      return (v as string | number) <= (f.value as string | number);
    case "gt":
      return (v as string | number) > (f.value as string | number);
    case "lt":
      return (v as string | number) < (f.value as string | number);
    case "ilike": {
      const pattern = String(f.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
      return new RegExp(`^${pattern}$`, "i").test(String(v ?? ""));
    }
    case "in":
      return f.values.includes(v);
    case "is":
      return f.value === null ? v === null || v === undefined : v === f.value;
    case "not-is":
      return f.value === null ? v !== null && v !== undefined : v !== f.value;
  }
}

/** `alias:table!inner(cols)` joins in a select string. */
function joins(select: string): { alias: string; inner: boolean }[] {
  const out: { alias: string; inner: boolean }[] = [];
  for (const m of select.matchAll(/(\w+):(\w+)(!inner)?\(/g)) out.push({ alias: m[1], inner: Boolean(m[3]) });
  return out;
}

let nextId = 1;

export function fakeSupabase(seed: Seed) {
  const tables: Seed = JSON.parse(JSON.stringify(seed));
  const writes: Write[] = [];

  function from(table: string) {
    const rows = () => (tables[table] ??= []);
    const filters: Filter[] = [];
    let op: "select" | "update" | "delete" | "insert" = "select";
    let patch: Row | null = null;
    let inserted: Row[] = [];
    let selectCols = "*";
    let wantCount = false;
    let head = false;
    let limit: number | null = null;
    let order: { col: string; asc: boolean } | null = null;

    const filtered = () => rows().filter((r) => filters.every((f) => matches(tables, r, f)));

    const project = (list: Row[]) => {
      let out = list.map((r) => ({ ...r }));
      for (const j of joins(selectCols)) {
        out = out
          .map((r) => ({ ...r, [j.alias]: related(tables, r, j.alias) }))
          .filter((r) => !j.inner || r[j.alias] !== null);
      }
      if (order) {
        const { col, asc } = order;
        out.sort((a, b) => {
          const x = a[col] as string | number | null;
          const y = b[col] as string | number | null;
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      if (limit !== null) out = out.slice(0, limit);
      return out;
    };

    const execute = () => {
      if (op === "select") {
        const out = project(filtered());
        return { data: head ? null : out, count: wantCount ? out.length : null, error: null };
      }
      if (op === "update") {
        const hit = filtered();
        for (const r of hit) Object.assign(r, patch);
        writes.push({ table, op, patch: patch ?? {}, filters: [...filters] });
        return { data: project(hit), count: hit.length, error: null };
      }
      if (op === "delete") {
        const hit = filtered();
        tables[table] = rows().filter((r) => !hit.includes(r));
        writes.push({ table, op, filters: [...filters] });
        return { data: project(hit), count: hit.length, error: null };
      }
      // insert
      for (const r of inserted) {
        if (r.id === undefined) r.id = `${table}-${nextId++}`;
        rows().push(r);
      }
      writes.push({ table, op: "insert", rows: inserted, filters: [] });
      return { data: project(inserted), count: inserted.length, error: null };
    };

    const self: Record<string, unknown> = {};
    self.select = vi.fn((cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (cols) selectCols = cols;
      if (opts?.count) wantCount = true;
      if (opts?.head) head = true;
      return self;
    });
    self.update = vi.fn((p: Row, opts?: { count?: string }) => {
      op = "update";
      patch = p;
      if (opts?.count) wantCount = true;
      return self;
    });
    self.delete = vi.fn(() => {
      op = "delete";
      return self;
    });
    self.insert = vi.fn((r: Row | Row[]) => {
      op = "insert";
      inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ ...x }));
      return self;
    });
    self.upsert = self.insert;
    for (const kind of ["eq", "neq", "gte", "lte", "gt", "lt", "ilike"] as const) {
      self[kind] = vi.fn((col: string, value: unknown) => {
        filters.push({ kind, col, value });
        return self;
      });
    }
    self.in = vi.fn((col: string, values: unknown[]) => {
      filters.push({ kind: "in", col, values });
      return self;
    });
    self.is = vi.fn((col: string, value: unknown) => {
      filters.push({ kind: "is", col, value });
      return self;
    });
    self.not = vi.fn((col: string, operator: string, value: unknown) => {
      if (operator === "is") filters.push({ kind: "not-is", col, value });
      return self;
    });
    self.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
      order = { col, asc: opts?.ascending !== false };
      return self;
    });
    self.limit = vi.fn((n: number) => {
      limit = n;
      return self;
    });
    self.range = vi.fn((fromIdx: number, toIdx: number) => {
      limit = toIdx - fromIdx + 1;
      return self;
    });
    const one = (strict: boolean) => ({
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const { data } = execute();
        const row = (data as Row[] | null)?.[0] ?? null;
        const payload = { data: row, error: strict && !row ? { message: "no rows" } : null };
        return Promise.resolve(payload).then(resolve, reject);
      },
    });
    self.single = vi.fn(() => one(true));
    self.maybeSingle = vi.fn(() => one(false));
    self.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject);
    return self;
  }

  return { from, tables, writes, auth: { getUser: async () => ({ data: { user: null } }) } };
}

export type FakeSupabase = ReturnType<typeof fakeSupabase>;
