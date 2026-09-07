"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Chip, SearchInput, StatusPill, Icons } from "@/components/ui";
import { ArticleRowMenu } from "@/components/dashboard/article-row-menu";
import { IndexBadge } from "@/components/dashboard/gsc-blocks";
import {
  HISTORY_FILTERS,
  countByFilter,
  filterHistory,
  formatMetric,
  sortByDateDesc,
  type HistoryFilter,
  type HistoryRow,
} from "@/lib/articles/history";
import { cn } from "@/lib/utils";

/**
 * The Articles table: content history for one site.
 *
 * Search and the status chips are client-side over rows the page already
 * loaded. The old bar wrote `q` into the URL and the page never read it, so
 * typing did nothing; a list this size (one site's articles) does not need a
 * round trip per keystroke. The chip counts describe what a click would show
 * given the current search, which is the only way a count next to a filter
 * is not a lie.
 *
 * Unknown numbers render as a dash. A difficulty nobody measured and a volume
 * nobody supplied are not zeroes (lib/types.ts says so on both columns).
 */
export function ArticleHistory({
  rows,
  initialStatus = "all",
  emptyState,
}: {
  rows: HistoryRow[];
  initialStatus?: HistoryFilter;
  /** Shown when the site has no articles at all, whatever the filters say. */
  emptyState: React.ReactNode;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<HistoryFilter>(initialStatus);

  const sorted = useMemo(() => sortByDateDesc(rows), [rows]);
  const byQuery = useMemo(() => filterHistory(sorted, { query }), [sorted, query]);
  const counts = useMemo(() => countByFilter(byQuery), [byQuery]);
  const shown = useMemo(() => filterHistory(byQuery, { status }), [byQuery, status]);
  // A featured-image column that no article has filled is nine rows of the
  // same grey placeholder icon and 68px of the width the title has to share.
  // It appears the moment one article has an image, and the placeholder is
  // then meaningful: it says which of these has none.
  const anyImage = useMemo(() => rows.some((r) => Boolean(r.imageUrl)), [rows]);

  const open = (id: string) => router.push(`/content/${id}`);

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SearchInput
          placeholder="Search by title…"
          className="flex-1 max-w-[320px]"
          value={query}
          onChange={setQuery}
        />
        {HISTORY_FILTERS.map((f) => (
          <Chip
            key={f.value}
            label={`${f.label} ${counts[f.value]}`}
            active={status === f.value}
            onClick={() => setStatus(f.value)}
          />
        ))}
      </div>

      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {[...(anyImage ? ["Image"] : []), "Title", "Keyword", "Difficulty", "Volume", "Clicks /30d", "Index", "Status", "Date", ""].map((h, i) => (
                <th
                  key={h || i}
                  className={cn(
                    "font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel",
                    ["Difficulty", "Volume", "Clicks /30d", "Date"].includes(h) ? "text-right" : "text-left",
                    // The title gets a fixed share of the row, or the numeric
                    // columns take what they like and the one column a person
                    // reads truncates to five letters.
                    h === "Title" && "w-[34%]",
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                onClick={() => open(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target === e.currentTarget) open(r.id);
                }}
                className="cursor-pointer hover:[&>td]:bg-panel focus-visible:[&>td]:bg-panel outline-none"
              >
                {anyImage && (
                  <td className="px-3.5 py-3 border-b border-line-soft w-[68px]">
                    {r.imageUrl ? (
                      // Plain <img>: featured images come from whatever storage the
                      // install uses, and next/image would need every host allowed
                      // in next.config to render one.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.imageUrl}
                        alt=""
                        loading="lazy"
                        className="w-12 h-8 rounded-[5px] object-cover bg-panel-2"
                      />
                    ) : (
                      <div
                        aria-label="No featured image"
                        className="w-12 h-8 rounded-[5px] bg-panel-2 grid place-items-center text-ink-4"
                      >
                        <Icons.articles size={13} />
                      </div>
                    )}
                  </td>
                )}
                <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                  <div className="truncate font-medium">{r.title}</div>
                </td>
                <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{r.keyword}</td>
                <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{formatMetric(r.difficulty)}</td>
                <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{formatMetric(r.volume)}</td>
                <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{formatMetric(r.clicks)}</td>
                <td className="px-3.5 py-3 border-b border-line-soft">
                  {r.index ? <IndexBadge bucket={r.index.bucket} title={r.index.title} /> : <span className="text-ink-4 text-xs">—</span>}
                </td>
                <td className="px-3.5 py-3 border-b border-line-soft">
                    <StatusPill status={r.status} />
                    {/* The rule's promise, next to the status it will change (079). */}
                    {r.status === "review" && r.held && (
                      <div className="mt-1 text-[11px] text-ink-3">Held</div>
                    )}
                    {r.status === "review" && !r.held && r.holdReason && (
                      <div className="mt-1 max-w-[180px] truncate text-[11px] text-[var(--err)]" title={r.holdReason}>Not auto-approved: {r.holdReason}</div>
                    )}
                    {r.status === "review" && !r.held && !r.holdReason && r.autoApproveAfter && (
                      <div className="mt-1 text-[11px] text-ink-3" title={new Date(r.autoApproveAfter).toLocaleString()}>{autoIn(r.autoApproveAfter)}</div>
                    )}
                  </td>
                <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2 whitespace-nowrap">
                  {r.date ? formatDate(r.date) : "—"}
                </td>
                <td className="px-3.5 py-3 border-b border-line-soft" onClick={(e) => e.stopPropagation()}>
                  <ArticleRowMenu articleId={r.id} currentStatus={r.status} canPublish={r.canPublish} canRetry={r.canRetry} held={r.held} autoApprove={Boolean(r.autoApproveAfter)} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={anyImage ? 10 : 9} className="px-3.5 py-10 text-center text-ink-3">{emptyState}</td>
              </tr>
            )}
            {rows.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={anyImage ? 10 : 9} className="px-3.5 py-8 text-center text-ink-3">
                  {query.trim()
                    ? <>No title contains &ldquo;{query.trim()}&rdquo;{status !== "all" ? ` in ${labelFor(status)}` : ""}.</>
                    : <>Nothing is {labelFor(status)} right now.</>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function labelFor(status: HistoryFilter): string {
  return (HISTORY_FILTERS.find((f) => f.value === status)?.label ?? status).toLowerCase();
}

/** UTC on purpose: the same string on the server and in every browser, so hydration never disagrees about a date near midnight. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "Publishes in 14h" / "Publishes on the next run", from the hold stamp. */
function autoIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "Publishes on the next run";
  const h = Math.round(ms / 3_600_000);
  return h < 1 ? "Publishes within the hour" : h < 48 ? `Publishes in ${h}h` : `Publishes in ${Math.round(h / 24)}d`;
}
