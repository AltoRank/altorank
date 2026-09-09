import Link from "next/link";
import { StartTrialButton } from "@/components/billing/start-trial-button";
import { TRIAL_OFFER } from "@/lib/billing/trial";

/**
 * The card ask, made after the drafts exist.
 *
 * The order is deliberate: the setup writes the account's first drafts against
 * the free allowance, the person reads them, and only then is a card asked
 * for. What the trial opens is approve, publish and everything after the
 * seventh draft; reading stays free with or without it. Shown only while
 * `quota.trialEligible` is true, so an account that already trialed sees the
 * plain ladder instead.
 */
export function TrialOffer({
  returnTo,
  secondary,
  compact = false,
}: {
  returnTo?: string;
  /** An alternative to the card: usually "read the draft first". */
  secondary?: { href: string; label: string };
  compact?: boolean;
}) {
  return (
    <div className={compact ? "rounded-[10px] border border-accent/30 bg-accent/5 p-4" : "rounded-[10px] border border-accent/30 bg-accent/5 p-5"}>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-accent">7-day trial</div>
      <p className="m-0 mb-3 text-[13.5px] leading-[1.6] text-ink">
        <strong>Approve, publish and keep writing.</strong> Your first drafts are free to read. The trial is what
        lets you put them on your site and keeps the schedule writing after them.
      </p>
      <p className="m-0 mb-4 text-[12.5px] leading-[1.6] text-ink-2">{TRIAL_OFFER}</p>
      <div className="flex flex-wrap items-center gap-3">
        <StartTrialButton returnTo={returnTo} />
        {secondary && (
          <Link href={secondary.href} className="text-[13px] text-ink-2 underline-offset-2 hover:underline">
            {secondary.label}
          </Link>
        )}
      </div>
    </div>
  );
}
