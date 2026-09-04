/**
 * A two-workspace Supabase stand-in, for asking one question of a query:
 * does it come back with only the site it was asked about?
 *
 * The bugs this exists to catch never threw and never leaked across accounts.
 * RLS narrows every read to the signed-in *agency*, so a query that forgot to
 * say which *workspace* still returned plausible rows - just too many of them,
 * and only for an account with a second site. A single-workspace fixture
 * reproduces none of that, which is exactly why it went unnoticed: with one
 * site, scoped and unscoped are the same list.
 *
 * So the fixture always holds two, and every assertion is "rows from A, none
 * from B". The store is deliberately dumb - it honours `.eq()` and counts
 * rows. It is not a database and should never grow into one; if a test needs
 * real SQL semantics it wants a real database instead.
 */
import { vi } from "vitest";

export const WORKSPACE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const WORKSPACE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

type Row = Record<string, unknown>;

/** Table name -> rows. Seeded per test; both workspaces always populated. */
export type Seed = Record<string, Row[]>;

/**
 * Rows for a table, split evenly-ish between the two workspaces.
 *
 * `make` receives the workspace and an index so a test can give rows distinct
 * titles or dates; everything else is the caller's business.
 */
export function twoWorkspaces(
  countPerWorkspace: number,
  make: (workspaceId: string, i: number) => Row,
): Row[] {
  const rows: Row[] = [];
  for (const ws of [WORKSPACE_A, WORKSPACE_B]) {
    for (let i = 0; i < countPerWorkspace; i++) rows.push(make(ws, i));
  }
  return rows;
}

type Filter = { col: string; value: unknown };

/** What a chain resolves to: rows, or a count when the caller asked for one. */
export type QueryResult = {
  data: Row[] | null;
  count: number;
  error: { message: string } | null;
};

/**
 * The subset of the PostgREST builder these tests use. Typed so a test can
 * await a chain and get rows back rather than `unknown`.
 */
export interface QueryChain extends PromiseLike<QueryResult> {
  select(cols?: string, opts?: { count?: string; head?: boolean }): QueryChain;
  eq(col: string, value: unknown): QueryChain;
  limit(n: number): QueryChain;
  order(...args: unknown[]): QueryChain;
  gte(...args: unknown[]): QueryChain;
  lte(...args: unknown[]): QueryChain;
  gt(...args: unknown[]): QueryChain;
  lt(...args: unknown[]): QueryChain;
  not(...args: unknown[]): QueryChain;
  in(...args: unknown[]): QueryChain;
  is(...args: unknown[]): QueryChain;
  neq(...args: unknown[]): QueryChain;
  ilike(...args: unknown[]): QueryChain;
  range(...args: unknown[]): QueryChain;
  single(): PromiseLike<{ data: Row | null; error: null }>;
  maybeSingle(): PromiseLike<{ data: Row | null; error: null }>;
}

/**
 * One query chain. Records `.eq()` calls, applies them on await, and answers
 * `{ count }` when the caller asked for a head count instead of rows.
 */
function chain(rows: Row[]): QueryChain & { __filters: Filter[] } {
  const filters: Filter[] = [];
  let headCount = false;
  let limit: number | null = null;

  const apply = () => {
    let out = rows.filter((r) => filters.every((f) => r[f.col] === f.value));
    if (limit !== null) out = out.slice(0, limit);
    return out;
  };

  const self: Record<string, unknown> = {};

  self.select = vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
    if (opts?.head) headCount = true;
    return self;
  });
  self.eq = vi.fn((col: string, value: unknown) => {
    filters.push({ col, value });
    return self;
  });
  self.limit = vi.fn((n: number) => {
    limit = n;
    return self;
  });
  // Filters this fixture does not model. They narrow rows in the real database
  // but never widen them, so ignoring them cannot turn a scoped query into an
  // unscoped-looking pass - the direction that would make a test lie.
  for (const noop of ["order", "gte", "lte", "gt", "lt", "not", "in", "is", "neq", "ilike", "range"]) {
    self[noop] = vi.fn(() => self);
  }
  self.single = vi.fn(() => ({
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: apply()[0] ?? null, error: null }).then(resolve),
  }));
  self.maybeSingle = self.single;

  self.then = (resolve: (v: unknown) => unknown) => {
    const out = apply();
    const payload = headCount
      ? { data: null, count: out.length, error: null }
      : { data: out, count: out.length, error: null };
    return Promise.resolve(payload).then(resolve);
  };

  /** What the query actually asked for, so a test can assert on the filter. */
  self.__filters = filters;
  return self as unknown as QueryChain & { __filters: Filter[] };
}

/** Every chain built during a test, for asserting that a filter was applied. */
export const chains: { table: string; filters: Filter[] }[] = [];

export function makeClient(seed: Seed): { from: (table: string) => QueryChain } {
  return {
    from: (table: string) => {
      const c = chain(seed[table] ?? []);
      chains.push({ table, filters: c.__filters });
      return c;
    },
  };
}

// No `mockSupabase()` helper here on purpose: `vi.mock` is hoisted by static
// analysis, so a call wrapped in a function is lifted out of this module and
// silently overrides whatever the test file registered. Each test file calls
// `vi.mock("@/lib/supabase/server", ...)` itself.

export function resetChains() {
  chains.length = 0;
}

/** True when some row in `rows` belongs to a workspace other than `expected`. */
export function leaksOtherWorkspace(rows: Row[], expected: string): boolean {
  return rows.some((r) => r.workspace_id !== undefined && r.workspace_id !== expected);
}
