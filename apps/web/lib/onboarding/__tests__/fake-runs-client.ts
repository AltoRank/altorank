/**
 * An in-memory stand-in for the PostgREST builder, for the onboarding run
 * tests: enough of `from().select/insert/update().eq/is/order/limit/single()`
 * to run the store, the worker and the routes against real rows rather than
 * against a mock that returns whatever the test says.
 *
 * Two pieces of the real schema are modelled because the code depends on
 * them: `onboarding_runs` gets a generated id and the 076 defaults on insert,
 * and its partial unique index (one `running` row per workspace) answers a
 * second insert with 23505 the way Postgres does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

type Filter = { col: string; op: "eq" | "is" | "not-is"; val: unknown };

let nextId = 1;

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  if (f.op === "is") return v === f.val;
  if (f.op === "not-is") return v !== f.val;
  // jsonb columns compare by value, the way `phases=eq.[]` does over the wire.
  if (v !== null && typeof v === "object") return JSON.stringify(v) === (typeof f.val === "string" ? f.val : JSON.stringify(f.val));
  return v === f.val;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Every update applied, in order: table and patch. */
  updates: { table: string; patch: Row }[];
  client: SupabaseClient;
}

export function fakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = { tables, updates: [], client: undefined as never };
  for (const t of ["onboarding_runs", "workspaces", "articles", "agency_members", "calendar_entries"]) db.tables[t] ??= [];

  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let patch: Row | null = null;
    let inserted: Row[] = [];
    const filters: Filter[] = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let single: "single" | "maybe" | null = null;
    let wantRows = true;
    let head = false;

    const run = () => {
      const rows = db.tables[table] ?? (db.tables[table] = []);
      if (op === "insert") {
        for (const r of inserted) {
          if (table === "onboarding_runs") {
            if (r.status === undefined) r.status = "running";
            if (r.status === "running" && rows.some((x) => x.workspace_id === r.workspace_id && x.status === "running")) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" }, count: null };
            }
            const now = new Date().toISOString();
            Object.assign(r, {
              id: r.id ?? `run-${nextId++}`,
              phases: r.phases ?? [],
              planned: r.planned ?? [],
              keywords_found: r.keywords_found ?? null,
              article_id: r.article_id ?? null,
              error: r.error ?? null,
              started_at: r.started_at ?? now,
              updated_at: r.updated_at ?? now,
              finished_at: r.finished_at ?? null,
            });
          } else if (r.id === undefined) {
            r.id = `${table}-${nextId++}`;
          }
          rows.push(r);
        }
        const data = single ? inserted[0] : inserted;
        return { data, error: null, count: null };
      }
      let hit = rows.filter((r) => filters.every((f) => matches(r, f)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, patch);
        db.updates.push({ table, patch: patch! });
        return { data: wantRows ? hit : null, error: null, count: null };
      }
      if (order) hit = [...hit].sort((a, b) => (String(a[order!.col]) < String(b[order!.col]) ? (order!.asc ? -1 : 1) : order!.asc ? 1 : -1));
      if (limit !== null) hit = hit.slice(0, limit);
      if (head) return { data: null, error: null, count: hit.length };
      if (single === "single") return { data: hit[0] ?? null, error: hit[0] ? null : { code: "PGRST116", message: "no rows" }, count: null };
      if (single === "maybe") return { data: hit[0] ?? null, error: null, count: null };
      return { data: hit, error: null, count: hit.length };
    };

    const q = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        wantRows = true;
        if (opts?.head) head = true;
        return q;
      },
      insert: (row: Row | Row[]) => ((op = "insert"), (inserted = (Array.isArray(row) ? row : [row]).map((r) => ({ ...r }))), (wantRows = false), q),
      update: (p: Row) => ((op = "update"), (patch = p), (wantRows = false), q),
      eq: (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), q),
      is: (col: string, val: unknown) => (filters.push({ col, op: "is", val }), q),
      not: (col: string, _op: string, val: unknown) => (filters.push({ col, op: "not-is", val }), q),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      single: () => ((single = "single"), q),
      maybeSingle: () => ((single = "maybe"), q),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  }

  db.client = { from: (table: string) => builder(table) } as unknown as SupabaseClient;
  return db;
}

/** A user client: the same rows, plus `auth.getUser()` answering as `user`. */
export function asUser(db: FakeDb, user: { id: string } | null): SupabaseClient {
  return {
    from: (table: string) => db.client.from(table),
    auth: { getUser: async () => ({ data: { user }, error: user ? null : { message: "no session" } }) },
  } as unknown as SupabaseClient;
}
