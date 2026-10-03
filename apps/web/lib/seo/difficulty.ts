/**
 * Two questions that look like one number.
 *
 * `difficulty` on a keyword is DataForSEO's KD, taken verbatim: a 0-100
 * estimate derived from the backlink profiles of the pages currently in the
 * top ten. It answers "how strong a site does this SERP demand?"
 *
 * It does NOT answer "can WE rank for this", and reading it as though it does
 * is how a DR 0.2 site ends up with a content plan built from KD 40 keywords.
 * KD 40 is a rounding error for a DR 80 domain and unreachable for a new one,
 * and the pipeline already fetches both numbers in the same run without ever
 * comparing them.
 *
 * So: keep KD as the absolute measure, and derive a relative one from the gap
 * between what the SERP demands and what the site has.
 */

/** Bands, so the UI can colour and sort without re-deriving the thresholds. */
export type Reachability = "comfortable" | "competitive" | "stretch" | "unrealistic";

export type RelativeDifficulty = {
  /** DataForSEO KD, 0-100. Null when unmeasured - never coalesce to 0. */
  absolute: number | null;
  /**
   * 0-100, where 0 is trivial for THIS site and 100 is out of reach. Null
   * when either input is unmeasured, because a guess here is worse than a
   * blank: it would put unwinnable keywords at the top of a content plan.
   */
  relative: number | null;
  band: Reachability | null;
  /** Plain-language, for selection_reasons and the keyword table. */
  reason: string;
};

/**
 * Authority and KD are both 0-100 but they are not the same scale, so this is
 * a deliberate, documented approximation rather than a formula with a claim to
 * precision: a site can compete about 20 points above its own authority before
 * the SERP stops being winnable with content alone.
 *
 * The number comes from the shape of the thing, not from a study - it is a
 * default to be tuned once we have ranked outcomes to check it against, which
 * is why the band names are qualitative and the score is never presented
 * without one.
 */
const REACH_ABOVE_AUTHORITY = 20;

export function relativeDifficulty(
  keywordDifficulty: number | null | undefined,
  siteAuthority: number | null | undefined,
): RelativeDifficulty {
  const absolute =
    typeof keywordDifficulty === "number" && Number.isFinite(keywordDifficulty)
      ? keywordDifficulty
      : null;

  if (absolute === null) {
    return {
      absolute: null,
      relative: null,
      band: null,
      reason: "difficulty not measured",
    };
  }

  if (typeof siteAuthority !== "number" || !Number.isFinite(siteAuthority)) {
    return {
      absolute,
      relative: null,
      band: null,
      reason: `difficulty ${absolute}, but this site's authority is not measured yet`,
    };
  }

  // How far the SERP's demand exceeds what the site brings. Negative means the
  // site is stronger than the page it would have to beat.
  const gap = absolute - (siteAuthority + REACH_ABOVE_AUTHORITY);
  const relative = Math.max(0, Math.min(100, Math.round(50 + gap * 2)));

  const band: Reachability =
    relative <= 25 ? "comfortable"
    : relative <= 50 ? "competitive"
    : relative <= 75 ? "stretch"
    : "unrealistic";

  const reason =
    band === "comfortable"
      ? `difficulty ${absolute}, comfortably within reach at authority ${siteAuthority}`
      : band === "competitive"
        ? `difficulty ${absolute}, winnable at authority ${siteAuthority} with a strong page`
        : band === "stretch"
          ? `difficulty ${absolute} against authority ${siteAuthority}: a stretch, expect months`
          : `difficulty ${absolute} is out of reach at authority ${siteAuthority}`;

  return { absolute, relative, band, reason };
}

/**
 * A difficulty nobody wins with content alone, whatever their authority.
 *
 * KD is derived from the backlink profiles of the pages already in the top
 * ten, so 90+ means those pages are the strongest documents on the web for
 * that phrase. A site that genuinely competes there reaches this code with a
 * ranking already attached (`source: "ranked"`, or an observed position), and
 * those rows are exempt everywhere this is used.
 *
 * Named separately from the relative judgement below because it needs no
 * authority measurement: it is the answer when there is no authority number
 * yet, which on a first analysis run is every workspace.
 */
export const HOPELESS_DIFFICULTY = 90;

/**
 * KD so high the SERP is out of everyone's reach, with no authority number
 * needed. This is the only difficulty judgement allowed to DROP a keyword;
 * `isOutOfReach` below only stops it being written.
 */
export function isHopeless(difficulty: number | null | undefined): boolean {
  return (
    typeof difficulty === "number" &&
    Number.isFinite(difficulty) &&
    difficulty >= HOPELESS_DIFFICULTY
  );
}

/**
 * Whether a keyword is out of reach for THIS site.
 *
 * The gap this closes: `relativeDifficulty` has existed since 2026-09-05 and
 * produces "unrealistic" for exactly these keywords, but nothing on the
 * writing path ever asked it. qasimcode.com (authority 0, signed up
 * 2026-09-07) was given twenty keywords of which five were KD 100 and eight
 * were KD 70 or worse, and an article was written for one of the KD 100s.
 *
 * Out of reach is a reason not to WRITE, not a reason to hide: the keyword is
 * still the market the customer is in, and their authority moves. The drop is
 * `isHopeless` above, which needs no authority and so is the answer during a
 * first run, when `workspaces.dr` is still null.
 */
export function isOutOfReach(
  difficulty: number | null | undefined,
  authority: number | null | undefined,
): boolean {
  if (typeof difficulty !== "number" || !Number.isFinite(difficulty)) return false;
  if (isHopeless(difficulty)) return true;
  return relativeDifficulty(difficulty, authority).band === "unrealistic";
}

/** Volume on a log scale: a 200,000/mo head term is not a hundred times a 2,000/mo one. */
export function volumeScore(volume: number): number {
  if (volume <= 0) return 0;
  return Math.log10(volume + 1) * 10;
}

/**
 * What an out-of-reach keyword keeps, rather than zero.
 *
 * `relativeDifficulty` saturates: at authority 0 every KD from 45 to 100 maps
 * to relative 100, so `1 - relative/100` was exactly 0 and multiplied the
 * whole score away. Twelve of qasimcode.com's twenty keywords scored 0.0 and
 * were therefore in arbitrary order - insertion order, since the sort is
 * stable - so the plan picked among KD 56, KD 86 and KD 100 by whichever row
 * the provider had returned first. Order has to survive even when the answer
 * is "none of these".
 */
const UNWINNABLE_FLOOR = 0.02;

/**
 * Difficulty as a 0-1 multiplier: how likely this site is to win the term.
 *
 * Unknown difficulty resolves to 0.6 rather than 1.0. Treating "we do not know"
 * as "easy" would float every unmeasured keyword to the top, which is the same
 * failure as rendering a null difficulty as a green zero. The recommender's
 * score multiplies by it, and the value tiers read it as "winnable" or not
 * (lib/keyword-research/value-tiers.ts).
 */
export function winnability(difficulty: number | null, volume = 0, authority?: number | null): number {
  if (difficulty === null) return 0.6;
  // Judged against this site when we know its authority. KD is absolute - it
  // describes the SERP, not the contender - so KD 40 is a rounding error at
  // DR 80 and unreachable at DR 0.2, and ranking both the same way is how a
  // new site gets a content plan it cannot execute. Both numbers are fetched
  // in the same analyseDomain run and were never compared.
  if (typeof authority === "number" && Number.isFinite(authority)) {
    const { relative } = relativeDifficulty(difficulty, authority);
    if (relative !== null) {
      if (difficulty === 0 && volume >= 1000) return 0.6;
      return Math.max(UNWINNABLE_FLOOR, 1 - relative / 100);
    }
  }
  // Difficulty 0 on a term with real volume is the provider saying "not
  // computed", not "free". Treated as easy it multiplies by 1.0 and floats a
  // fragment like "no keywords" (27,100/mo, KD 0) to the top of the queue.
  if (difficulty === 0 && volume >= 1000) return 0.6;
  const d = Math.min(Math.max(difficulty, 0), 100);
  return 1 - d / 100;
}
