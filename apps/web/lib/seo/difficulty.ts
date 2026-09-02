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
