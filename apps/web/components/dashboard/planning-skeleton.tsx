"use client";

// ---------------------------------------------------------------------------
// The month grid, before the month exists
// ---------------------------------------------------------------------------
//
// Pressing "Plan the month" used to change one word on a button. The label read
// "Planning…", the button disabled, and the calendar kept showing its empty
// state until the action returned and `router.refresh()` swapped the whole page
// at once. On a slow plan that is indistinguishable from a dead button, and the
// thing being waited for - a month of dates - was never drawn.
//
// It does not need a progress stream. Planning is scheduling, not generation:
// it reads keywords that already exist and inserts calendar_entries rows, with
// no model call anywhere in it. The dates it will choose are computable here,
// from the same `nextOpenDates` the server uses, so the grid can be drawn the
// moment the button is pressed and filled in when the rows land.
//
// What this deliberately does not claim: that an article exists. A placeholder
// says a day is being planned, not written. Drafting is the slow part and it
// happens afterwards, one draft per invocation (lib/content/fan-out.ts).

import { useMemo } from "react";
import { nextOpenDates, PLAN_HORIZON_DAYS } from "@/lib/onboarding/plan";
import { monthlyFromPace } from "@/lib/content/pace";

/** Weekday header, matching planner-grid's. */
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday-based column for a date, matching the grid's padding. */
function columnOf(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 6 : day - 1;
}

export function PlanningSkeleton({
  pace,
  occupied = [],
  from,
}: {
  /** Articles a week the plan will lay out, so the placeholders match the real shape. */
  pace: number;
  /** Dates that already carry an entry; they are not placeholders. */
  occupied?: string[];
  /** Injectable for tests. */
  from?: Date;
}) {
  const { cells, pad, count } = useMemo(() => {
    const start = from ?? new Date();
    // The same computation the server will do, so the placeholders sit on the
    // days that actually get filled rather than on an even spread.
    //
    // The third argument is how many dates to return, not the horizon: passing
    // PLAN_HORIZON_DAYS asked for thirty at every pace, which drew a full month
    // of placeholders for a site that plans four. The count is what the pace
    // yields over the horizon, which is the smaller of its monthly figure and
    // one per plan day - the same expression the plan popover quotes.
    const want = Math.min(monthlyFromPace(pace), Math.ceil((pace * PLAN_HORIZON_DAYS) / 7));
    const dates = nextOpenDates(occupied, pace, want, start);
    const planned = new Set(dates);

    const all: { iso: string; planned: boolean }[] = [];
    for (let i = 0; i < PLAN_HORIZON_DAYS; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = isoDay(d);
      all.push({ iso, planned: planned.has(iso) });
    }
    return { cells: all, pad: all.length ? columnOf(all[0].iso) : 0, count: dates.length };
  }, [pace, occupied, from]);

  return (
    <div
      className="overflow-hidden rounded-[10px] border border-line"
      role="status"
      aria-live="polite"
      aria-label={`Planning ${count} articles over the next ${PLAN_HORIZON_DAYS} days`}
    >
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
        {Array.from({ length: pad }, (_, i) => (
          <div
            key={`pad-${i}`}
            className="min-h-[130px] border-b border-r border-line-soft border-b-line-soft [&:nth-child(7n)]:border-r-0"
          />
        ))}
        {cells.map((cell) => (
          <div
            key={cell.iso}
            className="min-h-[130px] border-b border-r border-line-soft border-b-line-soft p-2 px-2.5 [&:nth-child(7n)]:border-r-0"
          >
            <div className="mb-1.5 font-mono text-[11px] text-ink-3">{cell.iso.slice(8, 10)}</div>
            {cell.planned && (
              <div className="animate-pulse rounded-[7px] border border-line bg-panel px-2 py-1.5">
                <div className="h-2 w-4/5 rounded bg-line" />
                <div className="mt-1.5 h-2 w-1/2 rounded bg-line-soft" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-line bg-panel px-3.5 py-2 text-[12px] text-ink-3">
        Planning {count} article{count === 1 ? "" : "s"} over the next {PLAN_HORIZON_DAYS} days. Each
        one is a date and a keyword; the drafts are written afterwards.
      </div>
    </div>
  );
}
