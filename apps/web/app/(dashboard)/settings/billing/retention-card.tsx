"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card, Dialog } from "@/components/ui";
import { cn } from "@/lib/utils";
import { pauseAccount, resumeAccount, cancelPlan, keepPlan } from "@/app/actions/retention";
import { PAUSE_MONTHS, PAUSE_COPY, formatPauseDate, pauseIsOver, type PauseMonths } from "@/lib/billing/pause";
import { CANCEL_REASONS, cancellationSummary, validateCancellation } from "@/lib/billing/cancellation";
import { inputClass } from "@/components/settings/fields";

/**
 * Leaving, without a maze.
 *
 * Pause is offered first and plainly: one, two or three months, everything
 * kept. Cancel is one button, a required question, and a confirmation that
 * says what happens next in a sentence. Neither path offers a discount or a
 * countdown; the one honest lever a product has here is being worth keeping.
 */
export function RetentionCard({
  pausedUntil,
  cancelsAt,
  periodEnd,
}: {
  /** Set when the account pause is active on the workspaces; null otherwise. */
  pausedUntil: string | null;
  /** Set when the subscription is already ending; null when it renews. */
  cancelsAt: string | null;
  periodEnd: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);

  function run(label: string, fn: () => Promise<unknown>) {
    start(async () => {
      try {
        await fn();
        toast.success(label);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  }

  const over = pausedUntil ? pauseIsOver(pausedUntil, new Date()) : false;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Pause instead of cancel">
        <p className="m-0 mb-4 text-[12.5px] leading-relaxed text-ink-2">{PAUSE_COPY}</p>
        {pausedUntil ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px]">
              {over ? (
                <>
                  The pause ended on <b>{formatPauseDate(pausedUntil)}</b>. Resume to start writing again.
                </>
              ) : (
                <>
                  Paused until <b>{formatPauseDate(pausedUntil)}</b>. Nothing is drafted or billed until then.
                </>
              )}
            </div>
            <Button variant="accent" onClick={() => run("Resumed. Writing and billing continue.", resumeAccount)} disabled={pending}>
              {pending ? "Resuming…" : "Resume now"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {PAUSE_MONTHS.map((m) => (
              <Button
                key={m}
                onClick={() =>
                  run(`Paused for ${m} ${m === 1 ? "month" : "months"}.`, () => pauseAccount(m as PauseMonths))
                }
                disabled={pending}
              >
                Pause {m} {m === 1 ? "month" : "months"}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Cancel">
        {cancelsAt ? (
          <>
            <p className="m-0 mb-4 text-[12.5px] leading-relaxed text-ink-2">
              Your plan ends on{" "}
              <b>{new Date(cancelsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</b>.
              Until then everything works as usual; afterwards your articles stay readable and exportable.
            </p>
            <Button onClick={() => run("Your plan renews as before.", keepPlan)} disabled={pending}>
              {pending ? "Saving…" : "Keep my plan"}
            </Button>
          </>
        ) : (
          <>
            <p className="m-0 mb-4 text-[12.5px] leading-relaxed text-ink-2">
              Ends the plan at the period end. {cancellationSummary(periodEnd)}
            </p>
            <Button onClick={() => setCancelOpen(true)} disabled={pending}>
              Cancel plan
            </Button>
          </>
        )}
      </Card>

      <CancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        periodEnd={periodEnd}
        onDone={() => {
          setCancelOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  periodEnd,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  periodEnd: string | null;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"why" | "confirm">("why");
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function next() {
    const v = validateCancellation({ reason, detail });
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  function confirm() {
    start(async () => {
      try {
        const r = await cancelPlan({ reason: reason ?? "", detail });
        toast.success(
          r.cancelsAt
            ? `Cancelled. You keep access until ${new Date(r.cancelsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}.`
            : "Cancelled at the end of the current period.",
        );
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not cancel.");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (pending) return;
        onOpenChange(v);
        if (!v) {
          setStep("why");
          setError(null);
        }
      }}
      title={step === "why" ? "Before you go: why?" : "Cancel your plan"}
      description={step === "why" ? "One answer, so we learn something. Required." : undefined}
    >
      {step === "why" ? (
        <div className="flex flex-col gap-2">
          {CANCEL_REASONS.map((r) => (
            <label
              key={r.id}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px]",
                reason === r.id ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-panel-2",
              )}
            >
              <input
                type="radio"
                name="cancel_reason"
                value={r.id}
                checked={reason === r.id}
                onChange={() => setReason(r.id)}
                className="accent-[var(--accent)]"
              />
              {r.label}
            </label>
          ))}
          <textarea
            rows={3}
            className={`${inputClass} mt-1 resize-none`}
            placeholder={reason === "other" ? "What happened? A sentence is plenty." : "Anything else? Optional."}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
          {error && <p className="m-0 text-[12.5px] text-err-ink">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Never mind
            </Button>
            <Button variant="accent" onClick={next}>
              Continue
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[13px] leading-relaxed text-ink-2">{cancellationSummary(periodEnd)}</p>
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-3">
            No further charges. Every draft, keyword and setting stays where it is, and you can come back to the
            same account.
          </p>
          {error && <p className="m-0 text-[12.5px] text-err-ink">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setStep("why")} disabled={pending}>
              Back
            </Button>
            <Button variant="primary" onClick={confirm} disabled={pending}>
              {pending ? "Cancelling…" : "Confirm cancellation"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
