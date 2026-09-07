// ---------------------------------------------------------------------------
// "Usage this month", in words that match what the code will actually do
// ---------------------------------------------------------------------------
//
// The Billing page's usage card had three separate copy bugs, all of them the
// same mistake: a sentence conditioned on the *kind* of account rather than on
// what the account can still do.
//
//   "Subscribe to generate articles" appeared on `reason === "no-plan"` alone,
//   so a brand-new account read it at 0 / 7 - while the real gate is
//   `remaining <= 0` and the next seven generations would have succeeded.
//
//   "included articles used" was the phrase for the seven free drafts as well
//   as for a paid tier's 100 or 400. "Included" is what the plans sell; the
//   free week is an allowance, and after a cancellation the same row could
//   read "150 / 7 included articles used" with the bar pinned red.
//
//   Nothing anywhere said the free drafts come back on the 1st, though
//   lib/plan/frozen.ts knows it and getQuota counts `used` from monthStart().
//
// So the copy is derived here, once, from the same Quota the gates read, and
// the page renders it. Kept out of the page component so it can be tested
// without a request.

import { nextResetDate, type Quota } from "@/lib/billing/quota";

export type UsageLine = {
  /** The counter, for the page's monospace span. "3 / 7", "150", "12". */
  figure: string;
  /** The sentence after it. Complete, punctuated, and true of this account. */
  sentence: string;
  /** Fraction of the allowance consumed, 0-1, or null when unmetered. */
  fraction: number | null;
  /** Whether the bar should read as spent. */
  exhausted: boolean;
};

function formatReset(now: Date): string {
  return nextResetDate(now).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function usageLine(quota: Quota, now: Date = new Date()): UsageLine {
  const { limit, used, reason } = quota;

  // Unmetered: self-host pays its own provider bills, operators are not
  // customer-shaped. There is no allowance to be a fraction of.
  if (limit === null) {
    return {
      figure: String(used),
      sentence: `articles generated. This account is unmetered (${
        reason === "operator" ? "operator" : "self-host"
      }).`,
      fraction: null,
      exhausted: false,
    };
  }

  const remaining = Math.max(0, limit - used);
  const exhausted = used >= limit;
  const fraction = limit === 0 ? 1 : Math.min(1, used / limit);

  if (reason === "no-plan") {
    // No reset date on this branch since 2026-09-07: the free drafts are a
    // one-time seven, `used` is the lifetime count, and "wait until Oct 1"
    // was a promise the counter no longer keeps.
    //
    // A cancelled account keeps its whole history here, so `used` can be far
    // past `limit`. "150 / 7" is arithmetic nobody can read; say what
    // happened instead.
    if (used > limit) {
      return {
        figure: String(used),
        sentence: `articles generated on this account. The free allowance of ${limit} is used — choose a plan to generate more. Self-hosting is free and unmetered.`,
        fraction: 1,
        exhausted: true,
      };
    }

    if (exhausted) {
      return {
        figure: `${used} / ${limit}`,
        sentence: `free drafts used. They are a one-time allowance, not a monthly one — choose a plan to generate more. Self-hosting is free and unmetered.`,
        fraction: 1,
        exhausted: true,
      };
    }

    // Nothing is blocked yet. What a plan buys is approving and publishing
    // what gets written (see requireActivePlan), which is a different
    // sentence - and, since 2026-09-07, everything else that costs money once
    // these run out.
    return {
      figure: `${used} / ${limit}`,
      sentence: `free drafts used of a one-time ${limit}, ${remaining} left. Approving or publishing one needs a plan; the drafts themselves do not.`,
      fraction,
      exhausted: false,
    };
  }

  // A downgrade keeps the month's real count while the included volume drops,
  // so `used` can be well past `limit` on a paid tier too - "150 / 100" is the
  // same unreadable arithmetic the free branch above already refuses to print,
  // and it arrives with no explanation of why the number moved.
  if (used > limit) {
    return {
      figure: String(used),
      sentence: `articles generated this month, on a plan that includes ${limit}. The ones already written stay; scheduled writing waits for ${formatReset(now)}, and an article written by hand bills at the published overage rate.`,
      fraction: 1,
      exhausted: true,
    };
  }

  return {
    figure: `${used} / ${limit}`,
    sentence: exhausted
      ? "included articles used. Scheduled writing stops here; an article written by hand bills at the published overage rate."
      : "included articles used.",
    fraction,
    exhausted,
  };
}
