// ---------------------------------------------------------------------------
// When a first look counts as having happened
// ---------------------------------------------------------------------------
//
// `first_analysed_at` is the flag that means "somebody has looked at this
// domain". `cron/analyze` selects on it being null, so stamping it ends the
// workspace's only claim on a first look for ever.
//
// It used to be stamped on every run, failures included, and the reason was
// sound: a domain that cannot be reached must not be re-crawled on every cron
// run for the rest of its life. What that missed is that "could not be
// reached" is usually a minute of bad luck, not a property of the site.
// Measured on production 2026-09-09: two of the eight workspaces - both of
// them real signups - were stamped `analysed` off a crawl that fetched
// **zero** pages, and both sites crawl fine on a retry (8/8 and 1/1 pages,
// usable topical profiles). Their onboarding therefore skipped keywords,
// pages, planning and drafting, and nothing in the product would ever look
// again: the profile refresh only rebuilds vocabulary, and it selects on
// `first_analysed_at` being *set*.
//
// #191 made the stamp conditional: a crawl that failed for a reason that
// clears on its own (`isTransientCrawlFailure` in domain-analysis.ts - a
// timeout, a reset, a DNS hiccup) leaves the column null, and one that failed
// for good (no DNS, a bad certificate, an HTTP refusal) stamps it. That is
// the right split, and this module keeps it. What it adds is the bound the
// old always-stamp rule was there to provide: a host that times out on every
// nightly look is retried MAX_ANALYSIS_ATTEMPTS times and then stamped, not
// retried until somebody notices the cron log.

/**
 * How many times a domain is looked at before we stop trying.
 *
 * Four: the onboarding run, then three nightly retries. A site that is down
 * for a deploy, rate-limiting a burst, or briefly behind a challenge page is
 * back inside that window; a domain that times out every night costs four
 * crawls and then nothing. A retry is cheap but not free: the crawl itself is
 * HTTP fetches, and the paid keyword layers are skipped without a usable
 * profile, but the authority and backlink lookups in the same run are not.
 */
export const MAX_ANALYSIS_ATTEMPTS = 4;

/**
 * How long after an attempt a workspace may be looked at again.
 *
 * `cron/analyze` runs once a night (02:00 UTC), so this is not what paces the
 * retries - the schedule is. What it stops is a workspace being counted twice
 * in one evening: an onboarding run at 23:50 and the 02:00 cron are two hours
 * apart and would otherwise spend two of the four attempts on the same outage.
 * Six hours is short enough that a signup earlier in the day - 18:37, say -
 * is still eligible on the same night's run.
 */
export const ANALYSIS_RETRY_BACKOFF_HOURS = 6;

export interface FirstLookInput {
  /** `workspaces.analysis_attempts` before this run. */
  attemptsBefore: number;
  /** What the crawl returned after its own in-run retries. */
  pagesCrawled: number;
  /**
   * True when the crawl failed for a reason tomorrow will not change - the
   * complement of `isTransientCrawlFailure` on the crawl layer's detail. A
   * run that threw before the crawl reported anything passes false: nothing
   * is known, so it is retried on the same terms as a blip.
   */
  failedForGood: boolean;
}

export interface FirstLookDecision {
  /** `analysis_attempts` after this run. */
  attempts: number;
  /**
   * Whether `first_analysed_at` should be stamped: the run read the site, the
   * site cannot be read, or the attempts are spent and nothing more will be
   * tried.
   */
  settled: boolean;
  /** Why, for the cron's result row. */
  reason: "read" | "unreachable" | "retry" | "gave-up";
}

/**
 * What one analysis run means for the workspace's first-look state. Pure.
 */
export function decideFirstLook(
  input: FirstLookInput,
  maxAttempts: number = MAX_ANALYSIS_ATTEMPTS,
): FirstLookDecision {
  const attempts = Math.max(0, input.attemptsBefore) + 1;
  if (input.pagesCrawled > 0) return { attempts, settled: true, reason: "read" };
  if (input.failedForGood) return { attempts, settled: true, reason: "unreachable" };
  if (attempts >= maxAttempts) return { attempts, settled: true, reason: "gave-up" };
  return { attempts, settled: false, reason: "retry" };
}

/**
 * The timestamp a workspace must have been attempted before to be eligible
 * again. Callers pass it to `.lt("last_analysis_attempt_at", …)`.
 */
export function retryEligibleBefore(
  now: Date,
  backoffHours: number = ANALYSIS_RETRY_BACKOFF_HOURS,
): string {
  return new Date(now.getTime() - backoffHours * 3_600_000).toISOString();
}

/** The columns `decideFirstLook` writes, ready to merge into a workspace update. */
export type FirstLookPatch = {
  analysis_attempts: number;
  last_analysis_attempt_at: string;
  first_analysed_at?: string;
};

export function firstLookPatch(decision: FirstLookDecision, now: string): FirstLookPatch {
  return {
    analysis_attempts: decision.attempts,
    last_analysis_attempt_at: now,
    ...(decision.settled ? { first_analysed_at: now } : {}),
  };
}
