"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icons } from "@/components/ui";
import {
  PHASE_LABELS,
  initialOnboardingState,
  isTerminal,
  reduceOnboarding,
  type OnboardingEvent,
  type OnboardingState,
  type OnboardingStep,
} from "@/lib/onboarding/events";

/**
 * The minute after someone adds their site, shown.
 *
 * This replaces a loading state that was not one: three labels flipped on
 * setTimeout(2000) and setTimeout(4000) while a server action ran for however
 * long it actually took, so "Discovering keywords…" was on screen during voice
 * training and "Done!" appeared whether or not anything had been done. Every
 * status here is an event the pipeline emitted at a real boundary.
 *
 * The calendar strip is the point of the screen. Keywords and a voice are
 * plumbing; a draft on a day is the thing the product sells, and watching the
 * square fill in is worth more than a checkmark saying it did.
 */

const HANDOFF_MS = 1_400;

export function OnboardingProgress({
  workspaceId,
  domain,
  onDone,
}: {
  workspaceId: string;
  domain: string;
  /** Called once, right before navigation, so a dialog can close itself. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(initialOnboardingState);
  const [closed, setClosed] = useState(false);
  const handedOff = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch("/api/onboard/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          setState((s) => reduceOnboarding(s, { phase: "error", detail: `Onboarding could not start (${res.status}).` }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames end in a blank line; anything after the last one is a
          // partial frame and waits for the next chunk.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const event = JSON.parse(line.slice(6)) as OnboardingEvent;
              setState((s) => reduceOnboarding(s, event));
            } catch {
              /* a malformed frame is not worth aborting the run over */
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          setState((s) => reduceOnboarding(s, { phase: "error", detail: "Lost the connection while setting up." }));
        }
      } finally {
        setClosed(true);
      }
    })();

    return () => controller.abort();
  }, [workspaceId]);

  // Hand off once the run is over - or once the stream has closed without
  // saying so, which is a timeout or a dropped connection. Either way the
  // dashboard is the right place to be: it polls a draft still in flight
  // (first-draft-live) and shows whatever did complete.
  const finished = isTerminal(state) || closed;
  useEffect(() => {
    if (!finished || handedOff.current) return;
    handedOff.current = true;
    const t = setTimeout(() => {
      onDone?.();
      router.push(`/workspaces/${workspaceId}`);
    }, HANDOFF_MS);
    return () => clearTimeout(t);
  }, [finished, onDone, router, workspaceId]);

  const drafting = state.steps.find((s) => s.phase === "drafting");

  return (
    <div className="flex flex-col gap-5" aria-live="polite">
      <div>
        <div className="text-[13px] font-medium text-ink">Setting up {domain}</div>
        <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-ink-2">
          {state.error
            ? state.error
            : state.ready
              ? "Done. Taking you to the dashboard."
              : "This takes about a minute. Nothing publishes without your approval."}
        </p>
      </div>

      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {state.steps.map((step) => (
          <StepRow key={step.phase} step={step} />
        ))}
      </ol>

      <CalendarStrip
        drafting={drafting?.status === "active"}
        article={state.article}
        skipped={drafting?.status === "skipped" || drafting?.status === "failed"}
        skippedReason={drafting?.status === "skipped" || drafting?.status === "failed" ? drafting.detail : undefined}
      />
    </div>
  );
}

function StepRow({ step }: { step: OnboardingStep }) {
  const label = step.status === "active" ? PHASE_LABELS[step.phase].active : PHASE_LABELS[step.phase].rest;
  const muted = step.status === "pending";
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
        {step.status === "active" ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        ) : step.status === "done" ? (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-ok-soft text-ok-ink">
            <Icons.check size={10} />
          </span>
        ) : step.status === "failed" ? (
          <span className="h-2 w-2 rounded-full bg-err-ink" />
        ) : step.status === "skipped" ? (
          <span className="h-2 w-2 rounded-full bg-ink-4" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-panel-2 ring-1 ring-line" />
        )}
      </span>
      <div className="min-w-0">
        <div className={`text-[13px] ${muted ? "text-ink-3" : "text-ink"}`}>{label}</div>
        {step.detail && step.status !== "active" && (
          <div className={`mt-0.5 text-[12px] leading-relaxed ${step.status === "failed" ? "text-err-ink" : "text-ink-3"}`}>
            {step.detail}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Seven days, today marked, and the square for today filling in.
 *
 * A skeleton while the draft is being written, then the real chip. The dates
 * are real so the strip reads as the calendar it is a preview of, and the chip
 * sits on today because that is when the draft was created - the same rule
 * lib/queries/calendar.ts uses to place a `drafting` article.
 */
function CalendarStrip({
  drafting,
  article,
  skipped,
  skippedReason,
}: {
  drafting: boolean;
  article: OnboardingState["article"];
  skipped: boolean;
  skippedReason?: string;
}) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - 1 + i);
    return d;
  });

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Your calendar</div>
      <div className="grid grid-cols-7 gap-1" role="presentation">
        {days.map((d, i) => {
          const isToday = i === 1;
          return (
            <div
              key={d.toISOString()}
              className={`flex min-h-[64px] flex-col rounded-md border px-1.5 py-1 ${
                isToday ? "border-accent/40 bg-accent/5" : "border-line bg-panel"
              }`}
            >
              <div className={`text-[10px] ${isToday ? "font-semibold text-accent-ink" : "text-ink-3"}`}>
                {d.toLocaleDateString(undefined, { weekday: "short" })}
                <span className="ml-1 font-mono">{d.getDate()}</span>
              </div>
              {isToday && drafting && !article && (
                <div className="mt-1.5 flex flex-col gap-1" aria-hidden>
                  <div className="h-2 w-full animate-pulse rounded-full bg-panel-2" />
                  <div className="h-2 w-3/4 animate-pulse rounded-full bg-panel-2" style={{ animationDelay: "140ms" }} />
                </div>
              )}
              {isToday && article && (
                <div
                  className="mt-1.5 truncate rounded-sm bg-accent/15 px-1 py-0.5 text-[10.5px] leading-tight text-accent-ink"
                  title={article.title}
                >
                  {article.keyword}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {article && (
        <p className="m-0 mt-2 text-[12px] text-ink-2">
          First draft is in your review queue
          {article.verdict === "high_risk" ? " with figures to check before publishing" : ""}.
        </p>
      )}
      {skipped && skippedReason && (
        <p className="m-0 mt-2 text-[12px] text-ink-3">{skippedReason}</p>
      )}
    </div>
  );
}
