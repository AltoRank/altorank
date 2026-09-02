"use client";

import { useActionState } from "react";
import { startImpersonation, type ImpersonationState } from "@/app/actions/impersonation";
import { Button } from "@/components/ui/button";

/**
 * One form per row. The action redirects into the customer's dashboard on
 * success; on failure the reason lands under the button instead of in a
 * stripped production error page.
 */
export function ImpersonateButton({
  userId,
  email,
  disabledReason,
}: {
  userId: string;
  email: string;
  /** When set, the button is disabled and this is the tooltip. */
  disabledReason?: string;
}) {
  const [state, action, pending] = useActionState<ImpersonationState, FormData>(startImpersonation, null);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="userId" value={userId} />
      <Button
        type="submit"
        size="sm"
        disabled={Boolean(disabledReason) || pending}
        title={disabledReason}
        aria-label={`View as ${email}`}
      >
        {pending ? "Opening…" : "View as"}
      </Button>
      {state?.error && (
        <span role="alert" className="max-w-[280px] text-right text-[11px] leading-snug text-err-ink">
          {state.error}
        </span>
      )}
    </form>
  );
}
