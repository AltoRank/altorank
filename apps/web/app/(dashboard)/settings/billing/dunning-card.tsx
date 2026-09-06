"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { createBillingPortalSession } from "@/app/actions/billing";
import { formatGraceDate, GRACE_DAYS, type DunningInfo } from "@/lib/billing/dunning";

/**
 * What the Billing page shows in place of the ladder while a renewal is
 * failing.
 *
 * The ladder was the wrong thing to show: to someone already paying for
 * Managed it offered "Choose Managed", which opened a second Checkout and a
 * second subscription. The only action that fixes a failed card is updating
 * the card, so that is the one button, with the portal's invoice screen
 * beside it for anyone who wants to see the failed attempt.
 */
export function DunningCard({
  planLabel,
  dunning,
  canManage,
}: {
  planLabel: string;
  dunning: DunningInfo;
  canManage: boolean;
}) {
  const [pending, start] = useTransition();

  function portal(flow: "manage" | "payment_method") {
    start(async () => {
      try {
        window.location.href = await createBillingPortalSession(flow);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open billing portal");
      }
    });
  }

  const graceDate = dunning.graceEndsAt ? formatGraceDate(dunning.graceEndsAt) : null;

  return (
    <div className="flex flex-col gap-4 p-[18px]">
      <div className="rounded-lg border border-warn bg-warn-soft p-4 text-[13px] leading-relaxed text-warn-ink">
        <p className="m-0 font-semibold">Payment failed — your {planLabel} plan needs a working card.</p>
        <p className="m-0 mt-1">
          {dunning.state === "grace" ? (
            <>
              The last renewal did not go through. Everything keeps working
              {graceDate ? <> until <b>{graceDate}</b></> : <> for {GRACE_DAYS} days</>} while Stripe retries the
              card; after that the account drops to the free tier until it is updated. Nothing is deleted either way.
            </>
          ) : (
            <>
              The card could not be charged and the grace period has ended, so the account is on the free tier:
              drafts continue, approving and publishing wait for the plan. Update the card and the {planLabel} plan
              comes back with the next successful charge.
            </>
          )}
        </p>
      </div>

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="accent" onClick={() => portal("payment_method")} disabled={pending}>
            {pending ? "Opening…" : "Update card"}
          </Button>
          <Button onClick={() => portal("manage")} disabled={pending}>
            Invoices and billing
          </Button>
        </div>
      ) : (
        <p className="m-0 text-[12.5px] text-ink-3">Only the account owner can update the card.</p>
      )}
    </div>
  );
}
