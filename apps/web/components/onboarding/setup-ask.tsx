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
import { judgedRows, type EmptyPool } from "@/lib/onboarding/events";

export const NOTHING_PLANNED_HEADING = "Nothing cleared the bar for a first article yet";

/**
 * The lede under that heading. The count is the searches a judge actually
 * decided (`judgedRows`), not every row in the pool: rows never reached were
 * not "checked", and a pool nobody could judge is never shown this at all
 * (`poolWasJudged`). The stage and the causes are for the operator, not for
 * a person deciding whether to trust us.
 *
 * `followUp`: the promise of a reply is made only when somebody will be told
 * (lib/auth/operators.ts `followUpPromised`). Without an operator address
 * there is no email and no digest, and the promise would be to nobody.
 */
export function nothingPlannedLede(domain: string, pool: EmptyPool | null, followUp: boolean): string {
  const site = domain || "your site";
  const judged = pool ? judgedRows(pool) : 0;
  const checked =
    judged > 0
      ? `We read ${site} and checked ${judged.toLocaleString("en-US")} ${judged === 1 ? "search" : "searches"} your buyers make, and none was clear enough to build a first article on yet.`
      : `We read ${site} and did not find a search clear enough to build a first article on yet.`;
  return followUp
    ? `${checked} Our team has been told, and you will hear back from us by email within 24 hours.`
    : `${checked} Nothing has been charged.`;
}

export function NothingPlannedNote({ followUp }: { followUp: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-bg p-4" data-testid="nothing-planned-note">
      <p className="m-0 text-sm font-medium text-ink">What happens next</p>
      <p className="m-0 mt-1.5 text-[13px] leading-[1.6] text-ink-2">
        {followUp
          ? "A person on our team looks at what we found and writes to you within 24 hours. There is nothing to pay and nothing you need to do until then."
          : "There is nothing to pay and nothing you need to do."}
      </p>
    </div>
  );
}

/** The card ask, or, when setup planned nothing, the note that replaces it. */
export function SetupAsk({
  ending,
  canBuy,
  followUp,
  returnTo = "/dashboard",
  requireArticle = false,
}: {
  ending: SetupEnding;
  canBuy: boolean;
  followUp: boolean;
  returnTo?: string;
  requireArticle?: boolean;
}) {
  if (requireArticle && ending !== "article") {
    return <div className="rounded-lg border border-line bg-bg p-4 text-[13px] leading-relaxed text-ink-2" role="status">
      {ending === "writing" ? "Your article is still being prepared. The trial offer will appear when it is ready." : "Your first look is saved. We need a suitable article before asking you to start a trial."}
    </div>;
  }
  if (!asksForCard(ending)) return <NothingPlannedNote followUp={followUp} />;
  return <TrialOffer canBuy={canBuy} returnTo={returnTo} />;
}
