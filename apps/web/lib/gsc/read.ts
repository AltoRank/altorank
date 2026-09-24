// ---------------------------------------------------------------------------
// The one Search Console reader
// ---------------------------------------------------------------------------
//
// `analytics_metrics` holds Search Console in four row shapes per day (total,
// query, page, query_page; lib/gsc/analysis.ts has the table), and the same
// click is in every one of them. Each reader used to write its own filter for
// the shape it wanted, and they kept getting it wrong in the same two ways:
//
// - A filter that let a second shape through. `.not("query", "is", null)`
//   reads as "query rows" and also matches query_page rows, so a sum over it
//   is about twice the truth; no filter at all is about four times. The client
//   report summed all four shapes and averaged the rows' CTRs, the article
//   research layer read query_page rows as more of the same query, and the
//   recommender once read them as "a page of yours targets this" (#235).
// - A read that stopped at 1,000 rows. PostgREST caps every response there and
//   says nothing when it does, so a 90-day read of a site with a few dozen
//   queries a day came back as whichever thousand rows the planner found first,
//   and was summed as if it were the whole window.
//
// So there is one reader, this one, and a guard test
// (lib/gsc/__tests__/read-guard.test.ts) that fails the build when any other
// file in apps/web names the table in a read, or asks this one for more than
// one shape without a reason on file. What it gives back is not short, and
// is not mixed unless a caller mixes it on purpose:
//
// - It is partitioned by shape. A caller names the shapes it wants and gets
//   one array per shape, never a flat list; the type says which partitions
//   exist, so reading one it did not ask for does not compile, and each
//   partition's rows carry their shape in their type (analysis.ts, `Shaped`),
//   so handing query_page rows to a function under the name `total` does not
//   compile either. What a type cannot stop is a caller that reads two shapes
//   and adds them together itself; that is why a multi-shape read has to be
//   explained in the guard's allowlist, where a reviewer sees it.
// - Each shape is its own query, filtered in SQL from SHAPE_COLUMNS, and every
//   row that comes back is checked against the same table in memory before it
//   is filed. The two cannot disagree, and a client that ignored the filter
//   (a test stub, a future refactor) still cannot put a row in the wrong
//   partition.
// - It is always `source = 'gsc'`. GA4 and Bing share the table and are not
//   Search Console; their readers stay where they are, allowlisted by the
//   guard with the reason.
// - It reads every row in the window, a page at a time, through
//   lib/supabase/read-all.ts: ordered by (metric_date, id), a unique order,
//   until the row count PostgREST reported on the first page is met. That
//   file says what paging by offset can and cannot promise while the nightly
//   sync is rewriting a day.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PAGE_SIZE, readAllPages } from "@/lib/supabase/read-all";
import { SHAPE_COLUMNS, rowShape, type GscShapes, type RowShape } from "./analysis";

/** Every Search Console column of an `analytics_metrics` row, as stored. */
export type StoredGscRow = {
  id: string;
  workspace_id: string;
  article_id: string | null;
  metric_date: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  avg_position: number | null;
  page_url: string | null;
  query: string | null;
  created_at: string;
};

/**
 * Always selected: the date the rows are ordered and windowed by, and the two
 * columns the shape check reads. A caller cannot opt out of the check by
 * leaving them off its column list.
 */
type Always = "metric_date" | "query" | "page_url";

/** The columns a caller may add to the three every row carries. */
export type GscColumn = Exclude<keyof StoredGscRow, Always>;

/** One row as read: the three that are always there, and what was asked for. */
export type ReadRow<C extends GscColumn> = Pick<StoredGscRow, Always | C>;

/**
 * PostgREST's `max_rows` (supabase/config.toml, and Supabase's hosted default),
 * which is also the page this reads. The db test pins that the local stack
 * really does stop an unpaged read here.
 */
export const GSC_PAGE_SIZE = PAGE_SIZE;

export type ReadGscOptions<S extends RowShape, C extends GscColumn> = {
  /**
   * The workspace to read. `null` is the account-wide read the dashboard's
   * all-sites view makes: RLS then decides which workspaces the signed-in
   * user's client can see. It is spelled out rather than left off so that no
   * caller gets it by forgetting; on a service-role client there is no RLS
   * behind it, and `null` would read every account.
   *
   * Anything else must be a real id. An empty string (or an `undefined` that
   * got past the type through a cast) throws, rather than being read as
   * "no filter": `.eq("workspace_id", "")` fails in Postgres, which is how the
   * readers this replaced failed closed, and this keeps them failing closed.
   */
  workspaceId: string | null;
  /** The partitions to read. The result has exactly these keys. */
  shapes: readonly S[];
  /** First day, inclusive, as YYYY-MM-DD. */
  since: string;
  /** Last day, inclusive, as YYYY-MM-DD. Omitted is "through the newest row". */
  until?: string;
  /** Columns beyond metric_date, query and page_url. */
  columns: readonly C[];
  /**
   * Only rows the sync attributed to one of our articles (it stamps
   * `article_id` on page and query_page rows whose URL is a live article):
   * that article's id, or "any" for every attributed row.
   */
  article?: string;
};

/**
 * Every Search Console row in the window, partitioned by shape.
 *
 * Throws on a database error, naming the shape. A caller that must not fail
 * on it (a research layer, a seeding step) catches it and says so in its own
 * words; a caller that renders numbers lets it throw, because a partial read
 * summed as if whole is the bug this module exists to end.
 */
export async function readGsc<S extends RowShape, C extends GscColumn>(
  supabase: SupabaseClient,
  opts: ReadGscOptions<S, C>,
): Promise<GscShapes<ReadRow<C>, S>> {
  const ws: unknown = opts.workspaceId;
  if (ws !== null && (typeof ws !== "string" || ws.trim() === "")) {
    throw new Error("readGsc: workspaceId must be a workspace id, or null for the account-wide read.");
  }
  const shapes = [...new Set(opts.shapes)];
  if (!shapes.length) throw new Error("readGsc: name at least one row shape to read.");
  const select = [...new Set<string>(["metric_date", "query", "page_url", ...opts.columns])].join(", ");
  const parts = await Promise.all(
    shapes.map(async (shape) => [shape, await readShape<C>(supabase, shape, select, opts)] as const),
  );
  return Object.fromEntries(parts) as GscShapes<ReadRow<C>, S>;
}

async function readShape<C extends GscColumn>(
  supabase: SupabaseClient,
  shape: RowShape,
  select: string,
  opts: ReadGscOptions<RowShape, C>,
): Promise<ReadRow<C>[]> {
  const columns = SHAPE_COLUMNS[shape];
  const rows = await readAllPages<ReadRow<C>>(`Search Console read (${shape} rows)`, (from, to, count) => {
    let q = supabase
      .from("analytics_metrics")
      .select(select, { count })
      .eq("source", "gsc")
      .gte("metric_date", opts.since);
    if (opts.until) q = q.lte("metric_date", opts.until);
    // Checked non-empty in readGsc; null, and only null, is the account-wide read.
    if (opts.workspaceId !== null) q = q.eq("workspace_id", opts.workspaceId);
    if (opts.article === "any") q = q.not("article_id", "is", null);
    else if (opts.article) q = q.eq("article_id", opts.article);
    // The shape, from the table: set is NOT NULL, unset is NULL.
    q = columns.query ? q.not("query", "is", null) : q.is("query", null);
    q = columns.page_url ? q.not("page_url", "is", null) : q.is("page_url", null);
    return q
      .order("metric_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: ReadRow<C>[] | null; error: { message: string } | null; count: number | null }>;
  });
  // The same table, asked again of each row. Against Postgres this never
  // drops anything; it is what keeps a client that did not apply the filter
  // from filing one click under four shapes.
  return rows.filter((row) => rowShape(row) === shape);
}

/**
 * The newest day Search Console has reported for this workspace, or null when
 * nothing has been synced. "Is the data fresh" is a Search Console read too,
 * so it lives here; it has no shape because every shape of a day is written
 * in one go.
 */
export async function latestGscDate(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from("analytics_metrics")
    .select("metric_date")
    .eq("workspace_id", workspaceId)
    .eq("source", "gsc")
    .order("metric_date", { ascending: false })
    .limit(1);
  return ((data?.[0] as { metric_date?: string } | undefined)?.metric_date as string | undefined) ?? null;
}

/** When the newest Search Console row was written: the last sync that stored anything. */
export async function lastGscWriteAt(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data } = await supabase
    .from("analytics_metrics")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .eq("source", "gsc")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data?.[0] as { created_at?: string } | undefined)?.created_at as string | undefined) ?? null;
}
