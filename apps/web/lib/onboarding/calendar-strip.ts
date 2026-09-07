// ---------------------------------------------------------------------------
// Which seven days the onboarding calendar strip draws, and what is on them
// ---------------------------------------------------------------------------
//
// The strip used to be seven squares that could only ever fill one. It took
// `{ drafting, article }` and gated every content branch on `i === 1`, so a run
// that planned seven articles across 09-07…09-13 rendered those exact dates as
// seven empty boxes - directly above a SCHEDULED list naming all seven. The
// window was an offset from today (`today.getDate() - 1 + i`), which showed
// yesterday and five days the plan might not even reach.
//
// The run state has carried the whole plan since migration 076
// (`OnboardingState.planned`, `lib/onboarding/events.ts`), so nothing new has
// to be fetched: the strip only has to read it. This module is the reading,
// kept pure and out of the component so the date arithmetic can be tested
// without a DOM (vitest runs in `node` here).
//
// Everything is UTC, because the plan is: `buildPlan` writes `YYYY-MM-DD` off
// `Date.UTC`, and the SCHEDULED list under the strip prints those strings raw.
// A strip that re-read them in the browser's zone would disagree with the list
// beside it by a day for half the world.

import type { OnboardingPlanned } from "@/lib/onboarding/events";

/** Squares in the strip. One week, which is what fits at this width. */
export const STRIP_DAYS = 7;

/** Chips a square shows before it starts counting the rest. */
export const MAX_CHIPS_PER_DAY = 2;

export interface StripDay {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** UTC today, so the highlight agrees with the dates the plan was written in. */
  isToday: boolean;
  /** Terms planned for this day, in plan order. May be longer than the square shows. */
  terms: string[];
}

export interface CalendarStripView {
  days: StripDay[];
  /** Planned entries after the last square. Named in a footnote, never dropped silently. */
  beyond: number;
  /** The last day the plan reaches, for that footnote. Null when nothing is planned. */
  lastDate: string | null;
  /**
   * The day the first draft belongs on: the first entry of the plan, which is
   * the one `runPipeline` hands to the writer ("the first day of the plan is
   * what the person just watched get scheduled"). Falls back to today for the
   * window before planning has emitted anything.
   */
  draftDate: string;
}

const DAY_MS = 86_400_000;

/** YYYY-MM-DD in UTC. */
export function isoDayUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A UTC-midnight Date for a YYYY-MM-DD, for formatting a weekday and a number. */
export function dayFromIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/**
 * The strip, from the plan itself.
 *
 * The window starts at the plan's own first day rather than at an offset from
 * today, so the squares are the days the plan actually commits to. With no
 * plan yet - the first seconds of a run, or a run whose planning phase was
 * skipped - it starts today, which is where the first draft would land, and
 * the squares are simply empty. That is the honest empty: the outcome line
 * above the strip is what says why.
 */
export function calendarStripDays(
  planned: readonly OnboardingPlanned[],
  now: Date = new Date(),
): CalendarStripView {
  const todayIso = isoDayUTC(now);
  const byDate = new Map<string, string[]>();
  for (const p of planned) {
    if (!p?.date) continue;
    const list = byDate.get(p.date);
    if (list) list.push(p.term);
    else byDate.set(p.date, [p.term]);
  }
  const dates = [...byDate.keys()].sort();
  const startIso = dates[0] ?? todayIso;
  const start = dayFromIso(startIso).getTime();

  const days: StripDay[] = [];
  for (let i = 0; i < STRIP_DAYS; i++) {
    const date = isoDayUTC(new Date(start + i * DAY_MS));
    days.push({ date, isToday: date === todayIso, terms: byDate.get(date) ?? [] });
  }

  const lastInWindow = days[days.length - 1].date;
  let beyond = 0;
  for (const [date, terms] of byDate) if (date > lastInWindow) beyond += terms.length;

  return {
    days,
    beyond,
    lastDate: dates.length > 0 ? dates[dates.length - 1] : null,
    draftDate: planned[0]?.date ?? todayIso,
  };
}
