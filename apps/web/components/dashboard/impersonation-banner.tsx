"use client";

import { useActionState } from "react";
import { stopImpersonation, type ImpersonationState } from "@/app/actions/impersonation";
import { Icons } from "@/components/ui/icons";

/**
 * Pinned above the whole app while an operator is signed in as a customer.
 *
 * It is the only thing on screen that says whose session this is: the
 * sidebar footer, the workspaces, the quota bar are all the customer's, which
 * is the point of the exercise and also why the bar cannot be dismissed. The
 * way back is here and nowhere else.
 */
export function ImpersonationBanner({
  operatorEmail,
  targetEmail,
  startedAt,
}: {
  operatorEmail: string;
  targetEmail: string;
  startedAt: string;
}) {
  const [state, action, pending] = useActionState<ImpersonationState, FormData>(stopImpersonation, null);

  return (
    <div
      role="status"
      className="shrink-0 flex items-center gap-3 px-4 h-10 bg-warn-soft text-warn-ink border-b border-warn text-[12.5px]"
    >
      <Icons.eye size={14} className="shrink-0" />
      <span className="truncate">
        Viewing as <b className="font-semibold">{targetEmail}</b>
        <span className="opacity-70">
          {" "}· since{" "}
          {/* Local time is only known in the browser; the server render
              cannot match it, so the mismatch is expected here. */}
          <time dateTime={startedAt} suppressHydrationWarning>
            {new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>{" "}
          · you are {operatorEmail}
        </span>
      </span>
      {state?.error && (
        <span role="alert" className="truncate text-err-ink">
          {state.error}
        </span>
      )}
      <form action={action} className="ml-auto shrink-0">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-warn-ink/30 bg-bg px-2.5 py-1 text-[12px] font-medium text-warn-ink hover:bg-panel-2 disabled:opacity-50"
        >
          <Icons.arrowLeft size={12} />
          {pending ? "Returning…" : "Back to my account"}
        </button>
      </form>
    </div>
  );
}
