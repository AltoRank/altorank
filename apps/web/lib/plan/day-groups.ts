// ---------------------------------------------------------------------------
// Laying entries out on a month grid
// ---------------------------------------------------------------------------
//
// A day can hold more than one article: a pace above one a day, or two planned
// keywords dragged onto the same square. The grid shows every entry on its day
// - the first few as cards, the rest collapsed into "+N more" - and the day
// header carries the count. Pure, so the grouping is tested without a page.

/** Cards shown per square before the rest collapse into "+N more". */
export const PER_DAY = 3;

/** `YYYY-MM-DD` for an ISO date or timestamp, read in UTC. */
export function isoDay(date: string): string {
  return date.slice(0, 10);
}

export type DayCell<T> = {
  /** `YYYY-MM-DD` */
  date: string;
  dayNum: number;
  items: T[];
};

/**
 * Build the cells of a month grid, Monday first, padded with `null` before the
 * first and after the last day so the caller renders whole weeks. Every entry
 * lands on its day; an entry outside the month is dropped rather than placed
 * on an arbitrary square.
 */
export function buildMonthCells<T>(
  entries: T[],
  year: number,
  month: number,
  dateOf: (entry: T) => string,
): Array<DayCell<T> | null> {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDayOfWeek = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const totalCells = Math.ceil((daysInMonth + firstDayOfWeek) / 7) * 7;
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;

  const byDay = new Map<number, T[]>();
  for (const e of entries) {
    const day = isoDay(dateOf(e));
    if (!day.startsWith(prefix)) continue;
    const n = Number(day.slice(8, 10));
    if (!Number.isInteger(n) || n < 1 || n > daysInMonth) continue;
    const arr = byDay.get(n) ?? [];
    arr.push(e);
    byDay.set(n, arr);
  }

  return Array.from({ length: totalCells }, (_, i) => {
    const dayNum = i - firstDayOfWeek + 1;
    if (dayNum < 1 || dayNum > daysInMonth) return null;
    return { date: `${prefix}${String(dayNum).padStart(2, "0")}`, dayNum, items: byDay.get(dayNum) ?? [] };
  });
}

/** The cards a square shows, and how many it hides behind "+N more". */
export function splitVisible<T>(items: T[], perDay = PER_DAY): { shown: T[]; hidden: number } {
  const shown = items.slice(0, perDay);
  return { shown, hidden: Math.max(0, items.length - shown.length) };
}
