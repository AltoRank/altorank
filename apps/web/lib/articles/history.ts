// ---------------------------------------------------------------------------
// Content history: the pure part of the Articles list
// ---------------------------------------------------------------------------
//
// The page renders a table; this module owns what goes in it. Kept free of
// React and Supabase so the title filter, the status chips and the "— not 0"
// rule can be tested without rendering anything.

import type { Article } from "@/lib/types";
import type { CoverageBucket } from "@/lib/gsc/analysis";

export type HistoryFilter = "all" | "review" | "approved" | "scheduled" | "live" | "archived";

/**
 * The chip row, in the order it renders. Review leads after All because it is
 * the only state that is a request for someone to do something.
 */
export const HISTORY_FILTERS: ReadonlyArray<{ value: HistoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "live", label: "Live" },
  { value: "archived", label: "Archived" },
];

export function isHistoryFilter(value: string | null | undefined): value is HistoryFilter {
  return HISTORY_FILTERS.some((f) => f.value === value);
}

/** One row of the table. Serialisable, so a server page can hand it to a client component. */
export interface HistoryRow {
  id: string;
  title: string;
  keyword: string;
  /** Null when nobody measured it. Rendered as —, never 0. */
  difficulty: number | null;
  /** Null when nothing supplied one. Rendered as —, never 0. */
  volume: number | null;
  status: string;
  /** ISO timestamp the row is dated and sorted by; null only for a broken row. */
  date: string | null;
  imageUrl: string | null;
  /** The row's workspace has a CMS connected, so "Publish now" can go out from the row menu. */
  canPublish: boolean;
  /** The last publish failed, so the row menu offers "Retry publish" instead of a fresh publish (#83). */
  canRetry: boolean;
  /** Search Console clicks attributed to the article over the last 30 days; null when nobody measured (#84). */
  clicks: number | null;
  /** Index coverage for a published URL, from URL inspection or from being served in search (#84). Null when not published. */
  index: { bucket: CoverageBucket; title: string } | null;
}

/** What the page knows about a row beyond the article itself. */
export interface HistoryRowExtras {
  canPublish: boolean;
  canRetry?: boolean;
  clicks?: number | null;
  index?: HistoryRow["index"];
}

/**
 * The date a reader would expect: when it went live, else when it is due,
 * else when it was last touched. Sorting by this puts what shipped most
 * recently at the top and a far-future schedule above it, which is the order
 * a content history reads in.
 */
export function historyDate(a: Pick<Article, "published_at" | "scheduled_at" | "updated_at">): string | null {
  return a.published_at ?? a.scheduled_at ?? a.updated_at ?? null;
}

export function toHistoryRow(a: Article, extras: HistoryRowExtras): HistoryRow {
  return {
    id: a.id,
    title: a.title,
    keyword: a.keyword,
    difficulty: typeof a.keyword_difficulty === "number" ? a.keyword_difficulty : null,
    volume: typeof a.volume === "number" ? a.volume : null,
    status: a.status,
    date: historyDate(a),
    imageUrl: a.featured_image_url ?? null,
    canPublish: extras.canPublish,
    canRetry: extras.canRetry ?? false,
    clicks: extras.clicks ?? null,
    index: extras.index ?? null,
  };
}

/** Case-insensitive substring match on the title only. Whitespace-only queries match everything. */
export function matchesTitle(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return title.toLowerCase().includes(needle);
}

export function filterHistory<T extends Pick<HistoryRow, "title" | "status">>(
  rows: readonly T[],
  opts: { query?: string; status?: HistoryFilter },
): T[] {
  const status = opts.status ?? "all";
  const query = opts.query ?? "";
  return rows.filter((r) => (status === "all" || r.status === status) && matchesTitle(r.title, query));
}

/** Counts per chip, over the rows the query already narrowed to, so the numbers describe what a click would show. */
export function countByFilter<T extends Pick<HistoryRow, "status">>(rows: readonly T[]): Record<HistoryFilter, number> {
  const counts: Record<HistoryFilter, number> = { all: rows.length, review: 0, approved: 0, scheduled: 0, live: 0, archived: 0 };
  for (const r of rows) {
    if (r.status in counts && r.status !== "all") counts[r.status as Exclude<HistoryFilter, "all">] += 1;
  }
  return counts;
}

/** Newest first. Rows with no date sink to the bottom rather than sorting as the epoch. */
export function sortByDateDesc<T extends Pick<HistoryRow, "date">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}

/** A number for the table, or a dash. Zero is a measurement and renders as "0"; null is not, and never becomes one. */
export function formatMetric(n: number | null): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}
