"use client";

// ---------------------------------------------------------------------------
// The ask at the end of setup, or the honest note in its place
// ---------------------------------------------------------------------------
//
// Both screens that end setup before the trial - the run screen and the gate a
// returning account lands on - render this in the slot where the card is
// asked, so the decision (`asksForCard`, lib/onboarding/setup-retry.ts) is
// made once. On 2026-09-28 both real signups' first looks planned nothing and
// were asked for a card over an empty calendar, under a heading that said
// setup had finished. Nothing was broken; nothing cleared the bar. The screen
// now says that, says a person has been told, and asks for nothing.

import { TrialOffer } from "@/components/billing/trial-offer";
import { asksForCard, type SetupEnding } from "@/lib/onboarding/setup-retry";
import type { EmptyPool } from "@/lib/onboarding/events";

export const NOTHING_PLANNED_HEADING = "Nothing cleared the bar for a first article yet";

/**
 * The lede under that heading. The count is the pool the run judged, when it
 * recorded one; the stage and the causes are for the operator, not for a
 * person deciding whether to trust us.
 */
export function nothingPlannedLede(domain: string, pool: EmptyPool | null): string {
  const site = domain || "your site";
  const checked =
    pool && pool.keywords > 0
      ? `We read ${site} and checked ${pool.keywords.toLocaleString("en-US")} ${pool.keywords === 1 ? "search" : "searches"} your buyers make, and none was clear enough to build a first article on yet.`
      : `We read ${site} and did not find a search clear enough to build a first article on yet.`;
  return `${checked} Our team has been told, and you will hear back from us by email within 24 hours.`;
}

export function NothingPlannedNote() {
  return (
    <div className="rounded-lg border border-line bg-bg p-4" data-testid="nothing-planned-note">
      <p className="m-0 text-sm font-medium text-ink">What happens next</p>
      <p className="m-0 mt-1.5 text-[13px] leading-[1.6] text-ink-2">
        A person on our team looks at what we found and writes to you within 24 hours. There is nothing to pay
        and nothing you need to do until then.
      </p>
    </div>
  );
}

/** The card ask, or, when setup planned nothing, the note that replaces it. */
export function SetupAsk({ ending, canBuy, returnTo = "/dashboard" }: { ending: SetupEnding; canBuy: boolean; returnTo?: string }) {
  if (!asksForCard(ending)) return <NothingPlannedNote />;
  return <TrialOffer canBuy={canBuy} returnTo={returnTo} />;
}
