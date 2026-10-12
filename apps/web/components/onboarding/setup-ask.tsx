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

import { TrialOffer, TrialPriceBox } from "@/components/billing/trial-offer";
import type { BillingInterval } from "@/lib/stripe";
import type { TrialOfferFacts } from "@/lib/billing/trial-offer";
import { asksForCard, type SetupEnding } from "@/lib/onboarding/setup-retry";
import { judgedRows, type EmptyPool } from "@/lib/onboarding/events";
import { trackStep } from "@/lib/onboarding/track-step";
import { TrackStep } from "./track-step";

export const NOTHING_PLANNED_HEADING = "We did not find a clear first topic yet";

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

/** The gate's offer: the interval it shares with the sticky bar, and the facts the server read. */
export interface GateOffer {
  interval: BillingInterval;
  onInterval: (next: BillingInterval) => void;
  facts: TrialOfferFacts;
  fullArticle: boolean;
  buttonRef?: React.Ref<HTMLDivElement>;
}

/** The card ask, or, when setup planned nothing, the note that replaces it. */
export function SetupAsk({
  ending,
  canBuy,
  followUp,
  returnTo = "/dashboard",
  offer,
  below,
}: {
  ending: SetupEnding;
  canBuy: boolean;
  followUp: boolean;
  returnTo?: string;
  /** The gate's price box; without it, the plain offer. */
  offer?: GateOffer;
  /** Under the ask: the soft exits (email me this article). */
  below?: React.ReactNode;
}) {
  // A retry: the button is above, and there is nothing to ask for.
  if (ending === "retry") return <p className="m-0 text-[12.5px] text-ink-2">Nothing has been charged, and running setup again costs nothing.</p>;
  // Our provider's outage: no card, no retry button, nobody promised beyond
  // what the heading says (the overnight retry and its email).
  if (ending === "provider-down") return <NothingPlannedNote followUp={false} />;
  if (!asksForCard(ending)) return <NothingPlannedNote followUp={followUp} />;
  // The gate is the card ask: shown is when this renders it (onboarding.step).
  return (
    <>
      <TrackStep step="gate_shown" />
      {offer ? (
        <TrialPriceBox
          canBuy={canBuy}
          interval={offer.interval}
          onInterval={offer.onInterval}
          facts={offer.facts}
          fullArticle={offer.fullArticle}
          returnTo={returnTo}
          onStart={() => trackStep("trial_clicked")}
          buttonRef={offer.buttonRef}
        />
      ) : (
        <TrialOffer canBuy={canBuy} returnTo={returnTo} onStart={() => trackStep("trial_clicked")} />
      )}
      {below}
    </>
  );
}
