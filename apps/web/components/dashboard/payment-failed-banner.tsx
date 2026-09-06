"use client";

import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { Icons } from "@/components/ui";
import { createBillingPortalSession } from "@/app/actions/billing";
import { formatGraceDate, type DunningInfo } from "@/lib/billing/dunning";

/**
 * Pinned above the app while a renewal is failing.
 *
 * Modelled on the impersonation and preview bars for the same reason: a
 * state that will change what the product lets you do has to say so before
 * it does, not after. A card that fails at renewal used to announce itself
 * as "No plan" on the Billing page a week later, with the gates already
 * shut. Not dismissible - it goes away when the card works.
 *
 * The button opens the portal's card screen and is owner-only, like every
 * other change to what the account pays; everyone else is told whom to ask.
 */
export function PaymentFailedBanner({
  dunning,
  canManage,
}: {
  dunning: DunningInfo;
  canManage: boolean;
}) {
  const [pending, start] = useTransition();

  function updateCard() {
    start(async () => {
      const result = await createBillingPortalSession("payment_method");
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      window.location.href = result.url;
    });
  }

  const graceDate = dunning.graceEndsAt ? formatGraceDate(dunning.graceEndsAt) : null;

  return (
    <div
      role="status"
      data-testid="payment-failed-banner"
      className="flex h-10 shrink-0 items-center gap-3 border-b border-warn bg-warn-soft px-4 text-[12.5px] text-warn-ink"
    >
      <Icons.billing size={14} className="shrink-0" />
      <span className="truncate">
        <b className="font-semibold">Payment failed</b> —{" "}
        {dunning.state === "grace" ? (
          <>
            update your card{graceDate ? <> before <b className="font-semibold">{graceDate}</b></> : null} to keep
            your plan. Everything works until then.
          </>
        ) : (
          <>your plan is on hold and the account is on the free tier until the card is updated.</>
        )}
        {!canManage && <span className="opacity-70"> Ask the account owner.</span>}
      </span>
      {canManage ? (
        <button
          onClick={updateCard}
          disabled={pending}
          className="ml-auto shrink-0 rounded-[6px] border border-warn bg-bg px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel disabled:opacity-50"
        >
          {pending ? "Opening…" : "Update card"}
        </button>
      ) : (
        <Link
          href="/settings/billing"
          className="ml-auto shrink-0 rounded-[6px] border border-warn bg-bg px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel"
        >
          Billing
        </Link>
      )}
    </div>
  );
}
