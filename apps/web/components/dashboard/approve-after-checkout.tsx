"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Icons } from "@/components/ui";
import { completeApprovalIntent, type ApprovalIntentResult } from "@/app/actions/approve-intent";

/**
 * The other half of the paywall: the buyer comes back and the approval happens.
 *
 * Mounted by the editor page when the URL carries `intent=approve&upgraded=1`,
 * which is what Stripe's success URL becomes after the CTA threaded the draft
 * through checkout. Nothing here decides anything - it calls the server action,
 * which re-runs the real approval with all of its checks - so this component's
 * whole job is the waiting, which is the part that used to be missing.
 *
 * The wait is real and ordinary: the browser redirect from Stripe regularly
 * beats `checkout.session.completed` to us, so the account still reads as
 * no-plan for a second or two. Polling that window is the difference between
 * "confirming your plan" and a paying customer being told to choose a plan.
 */
const POLL_MS = 1500;
/**
 * How long to keep asking. Stripe's webhook is usually within a second; a
 * minute is long enough that giving up means something is actually wrong, and
 * short enough that nobody watches a spinner forever. The fallback is a button,
 * never a dead end.
 */
const GIVE_UP_MS = 60_000;

type Phase = "working" | "confirming" | "settled" | "gave-up";

export function ApproveAfterCheckout({ articleId }: { articleId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("working");
  const [message, setMessage] = useState<string | null>(null);
  const startedAt = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  /** Drop `intent`/`upgraded` so a refresh does not re-run the attempt. */
  const clearIntent = useCallback(() => {
    router.replace(`/content/${articleId}`);
    router.refresh();
  }, [router, articleId]);

  const attempt = useCallback(async () => {
    let result: ApprovalIntentResult;
    try {
      result = await completeApprovalIntent(articleId);
    } catch (err) {
      result = { status: "error", reason: err instanceof Error ? err.message : String(err) };
    }
    if (cancelled.current) return;

    if (result.status === "confirming") {
      if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setPhase("gave-up");
        return;
      }
      setPhase("confirming");
      timer.current = setTimeout(() => void attempt(), POLL_MS);
      return;
    }

    setPhase("settled");
    if (result.status === "approved") {
      toast.success("Plan active — this draft is approved and ready to publish.");
      clearIntent();
      return;
    }
    // Everything else stays on screen rather than becoming a toast that
    // disappears: the person paid for this and is owed the reason in writing.
    setMessage(result.reason);
  }, [articleId, clearIntent]);

  useEffect(() => {
    cancelled.current = false;
    void attempt();
    return () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [attempt]);

  if (phase === "settled" && !message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-line bg-panel px-8 py-2.5 text-[12.5px] leading-relaxed text-ink-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {phase === "working" || phase === "confirming" ? (
          <>
            <Icons.refresh size={13} className="animate-spin text-ink-3" />
            <span>
              {phase === "confirming"
                ? "Confirming your plan with Stripe, then approving this draft. This takes a moment."
                : "Approving this draft…"}
            </span>
          </>
        ) : phase === "gave-up" ? (
          <>
            <span>
              Your payment went through, but the plan has not reached us yet, so the draft is still
              in review. Nothing is lost — try the approval again in a moment.
            </span>
            <Button
              size="sm"
              onClick={() => {
                startedAt.current = Date.now();
                setPhase("working");
                void attempt();
              }}
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            {/* The refusal a paying customer walked into. Said here, beside
                the draft, not in a toast that is gone before it is read. */}
            <span>{message}</span>
            <Button size="sm" onClick={clearIntent}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
