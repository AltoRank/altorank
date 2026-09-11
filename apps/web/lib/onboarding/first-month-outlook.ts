// ---------------------------------------------------------------------------
// What a first month is worth, stated as a range and never as a promise
// ---------------------------------------------------------------------------
//
// The trial gate asks for a card against a plan the person has not seen work
// yet. The honest thing to put beside that ask is what the plan could be worth
// if it lands - not a number, a range, with the assumption it rests on written
// next to it.
//
// Everything here is arithmetic over data already fetched and stored: the
// volume and difficulty DataForSEO priced for each planned keyword, and the
// site's own authority. Nothing is invented and nothing is fetched.
//
// The reason this is a range and not a figure: "86 of them failed every check"
// shipped on the marketing site in September 2026 and was false - the real
// minimum was 3 of 9. A single confident number is the same mistake wearing a
// better suit. A range with its basis shown survives a customer checking it in
// six months, which is exactly when they will.

import { relativeDifficulty, type Reachability } from "@/lib/seo/difficulty";

export type OutlookKeyword = {
  volume: number | null | undefined;
  difficulty: number | null | undefined;
};

export type TrafficRange = {
  /** Estimated organic clicks a month once these rank, low end. */
  low: number;
  /** The same, high end. */
  high: number;
  /** How many planned keywords the range is built from. */
  counted: number;
  /** Planned keywords left out: no volume, or out of reach for this site. */
  excluded: number;
};

/**
 * Share of searches the clicked result takes, by where it lands.
 *
 * Position-by-position click-through is public and well replicated (the
 * published curves agree within a point or two at the top and flatten fast).
 * Each band is a span rather than a point because we cannot know which
 * position inside it a page will take, and pretending otherwise is where a
 * range turns back into a promise.
 *
 * `unrealistic` earns nothing: `recommendKeywords` refuses to write those, so
 * counting their volume would sell traffic from articles the product declines
 * to produce.
 */
const CTR_BY_BAND: Record<Reachability, { low: number; high: number }> = {
  comfortable: { low: 0.035, high: 0.11 },
  competitive: { low: 0.02, high: 0.06 },
  stretch: { low: 0.008, high: 0.03 },
  unrealistic: { low: 0, high: 0 },
};

/** A keyword with no difficulty, or a site with no authority reading, cannot
 *  be placed on the curve. Treated as the middle band rather than dropped: a
 *  new site has no authority number on day one, and dropping every keyword
 *  then would show "no estimate" to exactly the customers being asked to
 *  decide. The band is the conservative middle, not the optimistic end. */
const UNKNOWN_BAND: Reachability = "competitive";

export function estimateFirstMonthTraffic(
  keywords: readonly OutlookKeyword[],
  authority: number | null | undefined,
): TrafficRange {
  let low = 0;
  let high = 0;
  let counted = 0;
  let excluded = 0;

  for (const k of keywords) {
    const volume = typeof k.volume === "number" && Number.isFinite(k.volume) && k.volume > 0 ? k.volume : 0;
    if (!volume) {
      excluded += 1;
      continue;
    }
    const band = relativeDifficulty(k.difficulty, authority).band ?? UNKNOWN_BAND;
    const ctr = CTR_BY_BAND[band];
    if (ctr.high === 0) {
      excluded += 1;
      continue;
    }
    low += volume * ctr.low;
    high += volume * ctr.high;
    counted += 1;
  }

  return { low: Math.round(low), high: Math.round(high), counted, excluded };
}

/** Whether the range is worth showing at all. A range of 0-3 clicks reads as
 *  a reason not to buy, and saying nothing is more honest than dressing it up. */
export function worthShowing(range: TrafficRange): boolean {
  return range.counted > 0 && range.high >= 10;
}
