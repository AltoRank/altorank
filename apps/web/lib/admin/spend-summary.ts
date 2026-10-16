// ---------------------------------------------------------------------------
// What provider_spend adds up to, all of it
// ---------------------------------------------------------------------------
//
// The Operations page read the newest 2,000 provider_spend rows and summed
// them. PostgREST answers at most 1,000 rows (supabase/config.toml max_rows,
// and the hosted default) and says nothing when it stops, so "Total spend",
// every breakdown and the 30-day actuals covered the newest thousand calls,
// and "Cost per article" divided that by an all-time article count.
//
// The sums are now made in the database (migration 116's
// provider_spend_summary), grouped the way the page reports them. Without 116
// the rows are read a page at a time (lib/supabase/read-all.ts) and grouped
// here the same way, so the page reads one shape either way.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "@/lib/supabase/read-all";

/** Every row sharing these values, summed. */
export interface SpendGroup {
  provider: string;
  operation: string;
  workspaceId: string | null;
  /** The first look's stage (migration 106); null outside one. */
  stage: string | null;
  /** Which work bought them (migration 116): a cron's name, `onboarding`, `editor`. */
  job: string | null;
  /** Whether the rows were bought for an article. */
  hasArticle: boolean;
  /** Made at or after the summary's `since`. */
  recent: boolean;
  calls: number;
  /** Calls that reported a price. A call with none is not a free call. */
  priced: number;
  usd: number;
}

export interface SpendSummary {
  /** Every recorded call. */
  calls: number;
  /** The oldest row's date, or null when there is none. */
  firstAt: string | null;
  /** Distinct articles that priced model calls were bought for. */
  modelArticles: number;
  groups: SpendGroup[];
}

export interface SpendRow {
  provider: string;
  operation: string;
  workspace_id: string | null;
  stage?: string | null;
  job?: string | null;
  article_id: string | null;
  cost_usd: number | string | null;
  created_at: string;
}

/** The same summary from rows, for a database without migration 116. */
export function summarizeSpendRows(rows: readonly SpendRow[], since: Date): SpendSummary {
  const cutoff = since.getTime();
  const groups = new Map<string, SpendGroup>();
  const modelArticles = new Set<string>();
  let firstAt: string | null = null;
  for (const r of rows) {
    const recent = Date.parse(r.created_at) >= cutoff;
    const g = {
      provider: r.provider,
      operation: r.operation,
      workspaceId: r.workspace_id ?? null,
      stage: r.stage ?? null,
      job: r.job ?? null,
      hasArticle: Boolean(r.article_id),
      recent,
    };
    const key = JSON.stringify(g);
    const into = groups.get(key) ?? { ...g, calls: 0, priced: 0, usd: 0 };
    into.calls += 1;
    if (r.cost_usd !== null && r.cost_usd !== undefined) {
      into.priced += 1;
      into.usd += Number(r.cost_usd);
      if (r.provider === "anthropic" && r.article_id) modelArticles.add(r.article_id);
    }
    groups.set(key, into);
    if (!firstAt || Date.parse(r.created_at) < Date.parse(firstAt)) firstAt = r.created_at;
  }
  return { calls: rows.length, firstAt, modelArticles: modelArticles.size, groups: [...groups.values()] };
}

/** The database's answer, in the page's shape. */
export function parseSpendSummary(raw: unknown): SpendSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(o.groups) ? (o.groups as Array<Record<string, unknown>>) : [];
  return {
    calls: Number(o.calls ?? 0),
    firstAt: typeof o.first_at === "string" ? o.first_at : null,
    modelArticles: Number(o.model_articles ?? 0),
    groups: groups.map((g) => ({
      provider: String(g.provider),
      operation: String(g.operation),
      workspaceId: typeof g.workspace_id === "string" ? g.workspace_id : null,
      stage: typeof g.stage === "string" ? g.stage : null,
      job: typeof g.job === "string" ? g.job : null,
      hasArticle: g.has_article === true,
      recent: g.recent === true,
      calls: Number(g.calls ?? 0),
      priced: Number(g.priced ?? 0),
      usd: Number(g.usd ?? 0),
    })),
  };
}

/**
 * Every provider_spend row, summed. `since` splits each group into recent
 * and older. Throws when neither the function nor the rows can be read: a
 * partial total shown as the whole is what this replaces.
 */
export async function readSpendSummary(db: SupabaseClient, since: Date): Promise<SpendSummary> {
  const { data, error } = await db.rpc("provider_spend_summary", { p_since: since.toISOString() });
  if (!error && data) return parseSpendSummary(data);
  const page = (columns: string) => (from: number, to: number, count: "exact" | undefined) =>
    db.from("provider_spend").select(columns, { count }).order("id").range(from, to) as unknown as PromiseLike<{
      data: SpendRow[] | null;
      error: { message: string } | null;
      count?: number | null;
    }>;
  // Without 116 there is no `job`, and before 106 no `stage`: each read asks
  // for one column less, and the last one's error is the one thrown.
  const base = "id, provider, operation, workspace_id, article_id, cost_usd, created_at";
  const shapes = [`${base}, stage, job`, `${base}, stage`, base];
  for (let i = 0; ; i++) {
    try {
      return summarizeSpendRows(await readAllPages<SpendRow>("provider_spend", page(shapes[i])), since);
    } catch (err) {
      if (i === shapes.length - 1) throw err;
    }
  }
}

/** Sum groups by a key, for the page's breakdowns. */
export function sumBy(groups: readonly SpendGroup[], key: (g: SpendGroup) => string | null): Map<string, { calls: number; usd: number }> {
  const out = new Map<string, { calls: number; usd: number }>();
  for (const g of groups) {
    const k = key(g);
    if (k === null) continue;
    const e = out.get(k) ?? { calls: 0, usd: 0 };
    e.calls += g.calls;
    e.usd += g.usd;
    out.set(k, e);
  }
  return out;
}
