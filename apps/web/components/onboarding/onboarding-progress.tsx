"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icons } from "@/components/ui";
import { calendarStripDays, dayFromIso, MAX_CHIPS_PER_DAY } from "@/lib/onboarding/calendar-strip";
import {
  initialOnboardingState,
  isTerminal,
  onboardingOutcome,
  phaseLabel,
  reduceOnboarding,
  stateFromRun,
  type OnboardingRunSnapshot,
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
 * status here is a phase the worker wrote to the run's row at a real boundary.
 *
 * The run does not live in this component's request. It used to: one SSE
 * fetch carried the whole pipeline, and its abort signal - a reload, a closed
 * tab, this effect's own cleanup - stopped the run at its next phase. Now
 * POST /api/onboard/start returns a run id at once and the work happens in
 * its own invocations; this polls GET /api/onboard/state for the row and
 * folds it through `stateFromRun`, the counterpart of the reducer the worker
 * wrote it with. Unmounting stops the polling and nothing else. Mounting
 * again - after a reload, tomorrow - picks the row up where it is.
 *
 * The calendar strip is the point of the screen. Keywords and a voice are
 * plumbing; a draft on a day is the thing the product sells, and watching the
 * square fill in is worth more than a checkmark saying it did.
 */

const HANDOFF_MS = 1_400;
/** Every three seconds while the phases are moving. */
export const POLL_MS = 3_000;
/** After two minutes the run is in the draft, where nothing changes for a while. */
export const POLL_SLOW_MS = 10_000;
export const POLL_BACKOFF_AFTER_MS = 2 * 60_000;

export function OnboardingProgress({
  workspaceId,
  domain,
  onDone,
  nextHref,
  autoNavigate = true,
  onState,
  initialRun = null,
}: {
  workspaceId: string;
  domain: string;
  /** Called once, right before navigation, so a dialog can close itself. */
  onDone?: () => void;
  /** Where to go when the run is over. Defaults to the workspace page. */
  nextHref?: string;
  /** False lets a parent own the hand-off (the wizard shows a button instead). */
  autoNavigate?: boolean;
  /** Every state change, for a parent that renders around this. */
  onState?: (state: OnboardingState) => void;
  /**
   * The run the page found on load, if any: rendered as the first frame, so
   * a reload shows the phases so far rather than four pending steps. A run
   * that has already finished is shown as it is and nothing is started.
   */
  initialRun?: OnboardingRunSnapshot | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(() =>
    initialRun?.run ? stateFromRun(initialRun.run, initialRun.article, { stale: initialRun.stale }) : initialOnboardingState(),
  );
  // `onDone` is a fresh arrow on every parent render. Reading it through a ref
  // keeps it out of the hand-off effect's dependencies, so a parent re-render
  // - the workspace list refreshing after creation, for one - cannot re-run
  // that effect and clear its timer.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const settledOnMount = Boolean(initialRun?.run && (initialRun.run.status !== "running" || initialRun.stale));

  // Start (or find) the run, then poll its row until it stops. The effect is
  // re-runnable: StrictMode runs it twice in development, and the second
  // POST finds the first's row and returns the same id, so nothing is doubled.
  // Cleanup only cancels the polling; the run is not this request's to stop.
  useEffect(() => {
    if (settledOnMount) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const fail = (detail: string) => setState((s) => reduceOnboarding(s, { phase: "error", detail }));

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/onboard/state?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        if (res.ok) {
          const snapshot = (await res.json()) as OnboardingRunSnapshot;
          if (cancelled) return;
          if (snapshot.run) {
            const next = stateFromRun(snapshot.run, snapshot.article, { stale: snapshot.stale });
            setState(next);
            if (isTerminal(next)) return;
          }
        }
      } catch {
        /* a missed poll is the next one's problem */
      }
      if (cancelled) return;
      timer = setTimeout(poll, Date.now() - startedAt > POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_MS);
    };

    (async () => {
      try {
        const res = await fetch("/api/onboard/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
        if (cancelled) return;
        if (!res.ok) {
          fail(`Onboarding could not start (${res.status}).`);
          return;
        }
        await poll();
      } catch {
        if (!cancelled) fail("Onboarding could not start. Check the connection and reload.");
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, settledOnMount]);

  // Hand off once the run is over - or once the row says it stopped
  // responding. Either way the dashboard is the right place to be: it polls a
  // draft still in flight (first-draft-live) and shows whatever did complete.
  const finished = isTerminal(state);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    onStateRef.current?.(state);
  }, [state]);
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(() => {
      onDoneRef.current?.();
      if (autoNavigate) router.push(nextHref ?? `/workspaces/${workspaceId}`);
    }, HANDOFF_MS);
    return () => clearTimeout(t);
  }, [finished, router, workspaceId, nextHref, autoNavigate]);

  const drafting = state.steps.find((s) => s.phase === "drafting");
  // The closing sentence is derived, not chosen: `ready` is emitted whatever
  // happened, so "Done. Your first month is on the calendar" used to print
  // over an empty calendar and a refused draft.
  const outcome = onboardingOutcome(state, autoNavigate);

  return (
    <div className="flex flex-col gap-5" aria-live="polite">
      <div>
        <div className="text-[13px] font-medium text-ink">Setting up {domain}</div>
        <p
          className={`m-0 mt-1 text-[12.5px] leading-relaxed ${outcome.tone === "error" ? "text-err-ink" : "text-ink-2"}`}
        >
          {outcome.line}
        </p>
      </div>

      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {state.steps.map((step) => (
          <StepRow key={step.phase} step={step} />
        ))}
      </ol>

      <CalendarStrip
        planned={state.planned}
        drafting={drafting?.status === "active"}
        article={state.article}
        skipped={drafting?.status === "skipped" || drafting?.status === "failed"}
        skippedReason={drafting?.status === "skipped" || drafting?.status === "failed" ? drafting.detail : undefined}
      />
    </div>
  );
}

function StepRow({ step }: { step: OnboardingStep }) {
  const label = phaseLabel(step);
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
        {step.detail && (
          <div className={`mt-0.5 text-[12px] leading-relaxed ${step.status === "failed" ? "text-err-ink" : "text-ink-3"}`}>
            {step.detail}
          </div>
        )}
      </div>
    </li>
  );
}

/** The weekday and day number for a `YYYY-MM-DD`, read in the zone it was written in. */
const DAY_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", timeZone: "UTC" };

/**
 * A week of the plan, with what is planned on each day.
 *
 * This took `{ drafting, article }` and nothing else, and gated every content
 * branch on `i === 1`, so seven squares could only ever fill one: a run that
 * planned seven articles across 09-07…09-13 drew those exact dates as empty
 * boxes, immediately above a SCHEDULED list that named all seven. The plan was
 * already in this component's own state - `OnboardingState.planned`, written
 * by the planning phase - so nothing had to be fetched to fix it, only passed
 * one level down.
 *
 * The window is the plan's own first week rather than an offset from today
 * (which showed yesterday and five days the plan might never reach); the days
 * past it are counted in a footnote rather than dropped. `calendarStripDays`
 * holds that arithmetic, in UTC, because the plan's dates are UTC and the list
 * below prints them raw.
 *
 * The pulsing skeleton stays, but only on the draft actually in flight: the
 * first entry of the plan, which is the one the pipeline hands to the writer.
 * Every other planned term is a plain chip, which is what it is - scheduled,
 * not being written.
 */
function CalendarStrip({
  planned,
  drafting,
  article,
  skipped,
  skippedReason,
}: {
  planned: OnboardingState["planned"];
  drafting: boolean;
  article: OnboardingState["article"];
  skipped: boolean;
  skippedReason?: string;
}) {
  const { days, beyond, lastDate, draftDate } = calendarStripDays(planned);

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Your calendar</div>
      <div className="grid grid-cols-7 gap-1" role="presentation">
        {days.map((day) => {
          const d = dayFromIso(day.date);
          const isDraftDay = day.date === draftDate;
          // The draft's own square shows the draft - as a skeleton while it is
          // written, then as the article - and the plan's term for that day is
          // what the skeleton stands for, so it is not repeated beside it.
          const showsDraft = isDraftDay && (article !== null || drafting);
          const rest = showsDraft ? day.terms.slice(1) : day.terms;
          const chips = rest.slice(0, showsDraft ? MAX_CHIPS_PER_DAY - 1 : MAX_CHIPS_PER_DAY);
          const more = rest.length - chips.length;
          return (
            <div
              key={day.date}
              className={`flex min-h-[64px] flex-col rounded-md border px-1.5 py-1 ${
                day.isToday ? "border-accent/40 bg-accent/5" : "border-line bg-panel"
              }`}
            >
              <div className={`text-[10px] ${day.isToday ? "font-semibold text-accent-ink" : "text-ink-3"}`}>
                {d.toLocaleDateString(undefined, DAY_LABEL)}
                <span className="ml-1 font-mono">{d.getUTCDate()}</span>
              </div>
              {isDraftDay && drafting && !article && (
                <div className="mt-1.5 flex flex-col gap-1" aria-hidden>
                  <div className="h-2 w-full animate-pulse rounded-full bg-panel-2" />
                  <div className="h-2 w-3/4 animate-pulse rounded-full bg-panel-2" style={{ animationDelay: "140ms" }} />
                </div>
              )}
              {isDraftDay && article && (
                <div
                  className="mt-1.5 truncate rounded-sm bg-accent/15 px-1 py-0.5 text-[10.5px] leading-tight text-accent-ink"
                  title={article.title}
                >
                  {article.keyword}
                </div>
              )}
              {chips.map((term) => (
                <div
                  key={term}
                  className="mt-1 truncate rounded-sm bg-panel-2 px-1 py-0.5 text-[10.5px] leading-tight text-ink-2"
                  title={term}
                >
                  {term}
                </div>
              ))}
              {more > 0 && <div className="mt-1 px-1 text-[10px] leading-tight text-ink-3">+{more}</div>}
            </div>
          );
        })}
      </div>
      {beyond > 0 && lastDate && (
        <p className="m-0 mt-2 text-[12px] text-ink-3">
          and {beyond} more on the calendar through{" "}
          {dayFromIso(lastDate).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}.
        </p>
      )}
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
