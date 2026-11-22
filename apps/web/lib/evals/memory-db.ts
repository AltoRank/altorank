// ---------------------------------------------------------------------------
// A database in memory: the tables and filters the first-look planner uses
// ---------------------------------------------------------------------------
//
// The first-look yield eval (./first-look.ts) runs the product's own planner
// end to end, and the planner reads and writes through a Supabase client. This
// stands in for one: rows in arrays, the handful of filters the planner
// chains, nothing else. Its unit tests use the same one, so the eval and the
// tests exercise the planner against the same thing.

import type { SupabaseClient } from "@supabase/supabase-js";

export type MemoryRow = Record<string, unknown>;

export function memoryDb(seed: Record<string, MemoryRow[]> = {}): { db: SupabaseClient; tables: Record<string, MemoryRow[]> } {
  const tables: Record<string, MemoryRow[]> = { keywords: [], calendar_entries: [], site_pages: [], keyword_rankings: [], workspaces: [], ...seed };
  let ids = 0;
  const client = {
    from(table: string) {
      const rows = () => (tables[table] ??= []);
      const filters: Array<(r: MemoryRow) => boolean> = [];
      let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
      let conflict = "id";
      let payload: MemoryRow | MemoryRow[] | null = null;
      const q: Record<string, unknown> = {};
      const matching = () => rows().filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (op === "insert") {
          const added = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: `${table}-${++ids}`, ...r }));
          rows().push(...added);
          return { data: added, error: null };
        }
        if (op === "update") { const hit = matching(); for (const r of hit) Object.assign(r, payload); return { data: hit, error: null }; }
        if (op === "upsert") {
          for (const r of Array.isArray(payload) ? payload : [payload!]) {
            const at = rows().findIndex((x) => x[conflict] === r[conflict]);
            if (at === -1) rows().push({ ...r });
            else rows()[at] = { ...rows()[at], ...r };
          }
          return { data: null, error: null };
        }
        if (op === "delete") { tables[table] = rows().filter((r) => !filters.every((f) => f(r))); return { data: null, error: null }; }
        return { data: matching(), error: null };
      };
      q.select = () => q;
      q.insert = (p: MemoryRow | MemoryRow[]) => { op = "insert"; payload = p; return q; };
      q.update = (p: MemoryRow) => { op = "update"; payload = p; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.upsert = (p: MemoryRow | MemoryRow[], o?: { onConflict?: string }) => { op = "upsert"; payload = p; conflict = o?.onConflict ?? "id"; return q; };
      q.order = () => q;
      q.eq = (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; };
      q.in = (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; };
      q.is = (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; };
      q.limit = () => q;
      q.single = async () => { const { data } = run(); return { data: Array.isArray(data) ? data[0] ?? null : data, error: null }; };
      q.maybeSingle = q.single;
      q.then = (resolve: (v: unknown) => unknown) => resolve(run());
      return q;
    },
  };
  return { db: client as unknown as SupabaseClient, tables };
}
