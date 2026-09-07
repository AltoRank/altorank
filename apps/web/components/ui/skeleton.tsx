import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Placeholders shaped like the page they stand in for
// ---------------------------------------------------------------------------
//
// Every dashboard page is an async server component that awaits its reads
// before rendering a byte, and for most of that time the app used to show one
// of two things: the previous page, frozen, or a centred spinner over
// "Loading…". Neither says what is coming. These primitives draw the head, the
// stat strip, the filter row and the table at their real sizes, in the same
// tokens `PageHead`, `StatStrip`, `Card` and `DataTable` paint with, so the
// data lands in cells that already exist rather than replacing a spinner with
// a page. The bars are `bg-line` on `bg-bg`, the pulse is Tailwind's, and the
// shapes borrow from `components/dashboard/planning-skeleton.tsx`, which was
// the first one of these in the app.
//
// Rules of the road:
// - A skeleton names what it is loading (`aria-label`) and is `aria-busy`, so
//   a screen reader hears "Loading articles", not silence, and does not read
//   fifty empty rows.
// - Text that is known before the data - the page title, the column headers,
//   a card's heading - is rendered as text, not as a bar. A grey bar where the
//   word "Articles" will go is a lie about what we know.
// - Nothing here claims a count. A table skeleton with eight rows says "a
//   table", not "eight articles".

/** A bar in the line colour, pulsing. Size it with `h-*`/`w-*`. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded bg-line", className)} />;
}

/** The lighter bar, for secondary text and body copy. */
export function SkeletonSoft({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded bg-line-soft", className)} />;
}

/** Stands in for `PageHead`'s `subtitle`: one 13px line. */
export function SubtitleSkeleton({ width = "w-48" }: { width?: string }) {
  return <Skeleton className={cn("h-3", width)} />;
}

/** Stands in for one `Button` (md) in `PageHead`'s `actions`. */
export function ActionSkeleton({ width = "w-28" }: { width?: string }) {
  return <Skeleton className={cn("h-[32px] rounded-[7px]", width)} />;
}

/**
 * The page body, with the same scroll container the real pages use
 * (`flex-1 overflow-y-auto px-8 py-6 scroll`), and the live-region wiring so
 * assistive tech gets one sentence instead of the placeholders.
 */
export function PageBodySkeleton({
  label,
  className,
  children,
}: {
  /** "Loading articles": read aloud once, and the `aria-label`. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn("flex-1 overflow-y-auto px-8 py-6 scroll", className)}
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * `PageHead` with nothing known: a detail page whose title is the row it is
 * loading. `back` draws the arrow's square so the title does not shift left
 * when the real arrow arrives.
 */
export function PageHeadSkeleton({
  back = false,
  titleWidth = "w-64",
  subtitleWidth,
  actions = 0,
}: {
  back?: boolean;
  titleWidth?: string;
  /**
   * A bar where the page's subtitle goes. All three routes using this render
   * one - `content/[id]`, `improvements/[id]`, `workspaces/[id]` - and there
   * was no slot for it, so the head visibly gained a second element on load.
   */
  subtitleWidth?: string;
  /** How many md buttons to reserve on the right. */
  actions?: number;
}) {
  return (
    // `flex-wrap md:flex-nowrap`, as PageHead has it: without it the skeleton
    // and the page it stands in for wrap differently on a narrow screen.
    <div className="min-h-[var(--topbar-h)] py-2 md:py-0 md:h-[var(--topbar-h)] shrink-0 px-8 border-b border-line flex flex-wrap md:flex-nowrap items-center gap-4">
      {back && <Skeleton className="shrink-0 w-[26px] h-[26px] -ml-1.5 rounded-[6px]" />}
      <Skeleton className={cn("h-5", titleWidth)} />
      {subtitleWidth && <SubtitleSkeleton width={subtitleWidth} />}
      {actions > 0 && (
        <div className="ml-auto flex flex-wrap md:flex-nowrap gap-2 max-w-full md:shrink-0">
          {Array.from({ length: actions }, (_, i) => (
            <ActionSkeleton key={i} width={i === 0 ? "w-28" : "w-24"} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * `StatStrip` at its real size: label, value, delta, in the same grid with
 * the same `gap-px bg-line` hairlines. `count` sets the columns exactly as
 * `cols` does on the real strip, so five stats do not wrap.
 */
export function StatStripSkeleton({ count = 4, compact = false }: { count?: number; compact?: boolean }) {
  return (
    <div
      className="grid gap-px bg-line border-b border-line grid-cols-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:grid-cols-[repeat(var(--cols),minmax(0,1fr))] sm:[&>*:last-child:nth-child(odd)]:col-span-1"
      style={{ "--cols": count } as React.CSSProperties}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn("bg-bg", compact ? "px-4 py-2.5" : "px-6 py-4")}>
          <SkeletonSoft className="mb-2 h-2.5 w-20" />
          <Skeleton className={cn(compact ? "h-4 w-12" : "h-5 w-14")} />
          {!compact && <SkeletonSoft className="mt-2.5 h-2.5 w-16" />}
        </div>
      ))}
    </div>
  );
}

/**
 * `Card` with its real title and a body of soft lines, or whatever children
 * the caller draws. The heading is text because it is known.
 *
 * `meta` and `flush` mirror `Card`'s own props, and for the same reason it
 * has them: a page whose card wraps a table renders it `flush`, and a
 * skeleton that pads the same table indents every column by 18px and then
 * un-indents them when the data lands. `/linking` drew both of its tables
 * outside a card entirely, which put them roughly a header's height off.
 */
export function CardSkeleton({
  title,
  meta,
  lines = 3,
  className,
  flush = false,
  children,
}: {
  title?: string;
  /** The right-hand slot of the header: a count, a control, a bar for one. */
  meta?: React.ReactNode;
  /** Lines of body copy to draw when there are no children. */
  lines?: number;
  className?: string;
  /** Render children edge to edge, as `Card flush` does. */
  flush?: boolean;
  children?: React.ReactNode;
}) {
  const body =
    children ??
    Array.from({ length: lines }, (_, i) => (
      <SkeletonSoft key={i} className={cn("h-3", i > 0 && "mt-3", i % 3 === 2 ? "w-1/2" : i % 3 === 1 ? "w-4/5" : "w-full")} />
    ));
  return (
    <div className={cn("bg-bg border border-line rounded-lg overflow-hidden", className)}>
      {title && (
        <div className="px-[18px] py-3.5 border-b border-line-soft flex items-center gap-2.5">
          <h3 className="m-0 text-sm font-semibold tracking-[-0.005em]">{title}</h3>
          {meta && <div className="ml-auto text-ink-3 text-xs">{meta}</div>}
        </div>
      )}
      {flush ? <div className="overflow-x-auto">{body}</div> : <div className="p-[18px]">{body}</div>}
    </div>
  );
}

/**
 * A row of filter chips, the shape `KeywordFilters` / `BacklinkFilters` /
 * the status tabs draw. Pills, not squares, so the row does not jump when
 * the real chips mount.
 */
export function FilterRowSkeleton({ chips = 4, className }: { chips?: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 mb-4 flex-wrap", className)}>
      {Array.from({ length: chips }, (_, i) => (
        <Skeleton key={i} className={cn("h-[22px] rounded-full", i === 0 ? "w-12" : i % 2 ? "w-20" : "w-16")} />
      ))}
    </div>
  );
}

/** Column widths that read as data rather than as a ruler. */
const CELL_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"];

/**
 * A `Card flush` holding a table with its real headers and `rows` rows of
 * bars. Headers are text: the reader knows the columns before the rows exist,
 * and the real `<th>` styling (from `DataTable`) means nothing moves when
 * the data replaces this. `numericFrom` right-aligns that column and every
 * later one, the way the real tables do for their number columns.
 */
export function TableSkeleton({
  columns,
  rows = 6,
  numericFrom,
  numeric = [],
  className,
}: {
  columns: string[];
  rows?: number;
  /** Index of the first right-aligned column; leave unset for none. */
  numericFrom?: number;
  /** Individual right-aligned columns, for tables whose numbers sit mid-row. */
  numeric?: number[];
  className?: string;
}) {
  const isNumeric = (i: number) => numeric.includes(i) || (numericFrom !== undefined && i >= numericFrom);
  return (
    <div className={cn("bg-bg border border-line rounded-lg overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {columns.map((h, i) => (
                <th
                  key={`${h}-${i}`}
                  className={cn(
                    "font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel whitespace-nowrap",
                    isNumeric(i) ? "text-right" : "text-left",
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                {columns.map((h, c) => {
                  const primary = c === 0;
                  return (
                    <td key={`${h}-${c}`} className="px-3.5 py-3 border-b border-line-soft align-middle">
                      {primary ? (
                        <>
                          <Skeleton className={cn("h-3", CELL_WIDTHS[(r + c) % CELL_WIDTHS.length])} />
                          <SkeletonSoft className="mt-1.5 h-2.5 w-2/5" />
                        </>
                      ) : isNumeric(c) ? (
                        <Skeleton className="ml-auto h-3 w-10" />
                      ) : h === "" ? (
                        <Skeleton className="h-6 w-6 rounded-[6px]" />
                      ) : (
                        <SkeletonSoft className={cn("h-3", CELL_WIDTHS[(r * 3 + c) % CELL_WIDTHS.length])} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A settings card: `fields` labelled inputs at the input's real height and a
 * save button. The Settings tabs render this while the form's row loads.
 */
export function FormCardSkeleton({ fields = 3, className }: { fields?: number; className?: string }) {
  return (
    <div className={cn("bg-bg border border-line rounded-lg overflow-hidden", className)}>
      <div className="px-[18px] py-3.5 border-b border-line-soft flex items-center gap-2.5">
        <Skeleton className="h-3.5 w-32" />
      </div>
      <div className="p-[18px] space-y-4">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i}>
            <SkeletonSoft className="mb-1.5 h-2.5 w-24" />
            <div className="h-[34px] w-full rounded-[7px] border border-line bg-bg" />
          </div>
        ))}
        <div className="flex justify-end pt-1">
          <ActionSkeleton width="w-20" />
        </div>
      </div>
    </div>
  );
}

/**
 * A grid of tile cards - integrations, voices - each with an icon square, a
 * title, two lines and a button, the shape the Integrations tiles have.
 */
export function CardGridSkeleton({
  count = 4,
  cols = "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
  className,
}: {
  count?: number;
  cols?: string;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3", cols, className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="border border-line rounded-[10px] p-4 bg-bg">
          <div className="flex items-center gap-2.5">
            <Skeleton className="w-8 h-8 rounded-[7px]" />
            <div className="flex-1">
              <Skeleton className="h-3 w-24" />
              <SkeletonSoft className="mt-1.5 h-2.5 w-14" />
            </div>
            <Skeleton className="h-[18px] w-20 rounded-full" />
          </div>
          <SkeletonSoft className="mt-3 h-2.5 w-full" />
          <SkeletonSoft className="mt-1.5 h-2.5 w-4/5" />
          <Skeleton className="mt-3 h-[28px] w-full rounded-[7px]" />
        </div>
      ))}
    </div>
  );
}

/** Weekday header, matching planner-grid's and planning-skeleton's. */
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The month grid before its entries, drawn for the current month so the day
 * numbers are right from the first frame: the entries land in cells that
 * already exist rather than in a grid that appears with them.
 *
 * `filled` placeholder entries are spread over weekdays, one every few days,
 * to say "a plan goes here" without claiming which days. The weekday-only
 * spread matches `nextOpenDates`, which never plans a weekend.
 */
export function CalendarSkeleton({ weeks, filled = 0, from }: { weeks?: number; filled?: number; from?: Date }) {
  const now = from ?? new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const pad = firstDay === 0 ? 6 : firstDay - 1;
  const rows = weeks ?? Math.ceil((pad + daysInMonth) / 7);
  const cells = rows * 7;

  // Every weekday from today onward is a candidate; pick `filled` of them at
  // an even stride so the placeholders read as a cadence, not a cluster.
  const today = now.getUTCDate();
  const candidates: number[] = [];
  for (let d = today; d <= daysInMonth; d++) {
    const dow = (pad + d - 1) % 7;
    if (dow < 5) candidates.push(d);
  }
  const stride = Math.max(1, Math.floor(candidates.length / Math.max(1, filled)));
  const planned = new Set(candidates.filter((_, i) => i % stride === 0).slice(0, filled));

  return (
    <div className="overflow-hidden rounded-[10px] border border-line">
      <div className="grid grid-cols-7 min-w-[640px] border-b border-line bg-panel">
        {DAYS.map((d) => (
          <div
            key={d}
            className="border-r border-line px-3.5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 [&:nth-child(7n)]:border-r-0"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 min-w-[640px]">
        {Array.from({ length: cells }, (_, i) => {
          const day = i - pad + 1;
          const inMonth = day >= 1 && day <= daysInMonth;
          return (
            <div
              key={i}
              className="min-h-[130px] border-b border-r border-line-soft p-2 px-2.5 [&:nth-child(7n)]:border-r-0"
            >
              {inMonth && (
                <>
                  <div className={cn("mb-1.5 font-mono text-[11px]", day === today ? "text-ink" : "text-ink-3")}>
                    {String(day).padStart(2, "0")}
                  </div>
                  {planned.has(day) && (
                    <div className="animate-pulse rounded-[7px] border border-line bg-panel px-2 py-1.5">
                      <div className="h-2 w-4/5 rounded bg-line" />
                      <div className="mt-1.5 h-2 w-1/2 rounded bg-line-soft" />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
