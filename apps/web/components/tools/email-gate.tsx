"use client";

import { useActionState, useState } from "react";
import { captureToolLead, type CaptureState } from "@/app/actions/capture";

type EmailGateProps = {
  toolSlug: string;
  label?: string;
  description?: string;
  /**
   * The tool's result data. When `sendEmail` is set the server renders the
   * email from it (lib/tools/result-email.ts); the browser never supplies a
   * subject or a body.
   */
  context?: Record<string, unknown>;
  sendEmail?: boolean;
  onSuccess?: () => void;
};

const INITIAL: CaptureState = { success: false };

export function EmailGate({
  toolSlug,
  label = "Email me this report",
  description = "Get the full results delivered to your inbox.",
  context,
  sendEmail = false,
  onSuccess,
}: EmailGateProps) {
  const [submitted, setSubmitted] = useState(false);

  const wrappedAction = async (
    prev: CaptureState,
    formData: FormData,
  ): Promise<CaptureState> => {
    const result = await captureToolLead(prev, formData);
    if (result.success) {
      setSubmitted(true);
      onSuccess?.();
    }
    return result;
  };

  const [state, formAction, isPending] = useActionState(
    wrappedAction,
    INITIAL,
  );

  if (submitted) {
    return (
      <div className="rounded-xl border border-[oklch(0.85_0.08_155)] bg-[oklch(0.97_0.02_155)] px-5 py-4 text-center">
        <p className="text-sm font-medium text-[oklch(0.4_0.1_155)]">
          Sent! Check your inbox.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-accent-soft bg-panel p-5">
      <p className="mb-1 text-sm font-semibold text-ink">{label}</p>
      <p className="mb-3 text-[13px] text-ink-2">{description}</p>

      <form action={formAction} className="flex gap-2">
        <input type="hidden" name="toolSlug" value={toolSlug} />
        {context && (
          <input
            type="hidden"
            name="context"
            value={JSON.stringify(context)}
          />
        )}
        {sendEmail && <input type="hidden" name="sendEmail" value="true" />}

        <input
          name="email"
          type="email"
          required
          placeholder="you@company.com"
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={isPending}
          className="shrink-0 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-2 disabled:opacity-50"
        >
          {isPending ? "Sending..." : "Send"}
        </button>
      </form>

      {state.error && (
        <p className="mt-2 text-xs text-[oklch(0.5_0.15_25)]">{state.error}</p>
      )}
    </div>
  );
}
