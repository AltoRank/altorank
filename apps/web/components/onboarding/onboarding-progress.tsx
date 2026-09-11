"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FirstLookReportView } from "./first-look-report";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";
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
/**
 * Polls in a row that answered with anything but a run before the screen stops
 * asking and says so.
 *
 * Terminal detection needs a successful read: a 401 from an expired session, a
 * 500, or a row the route cannot see leaves `isTerminal` unreached, and the
 * loop simply reschedules. The only ceiling on this screen is `RUN_STALE_MS`,
 * which is computed server-side from `updated_at` and therefore requires the
 * very read that is failing - so a signed-out tab sat here spinning its five
 * step icons and printing "This takes about a minute" indefinitely.
 *
 * Ten is a minute of the fast cadence, which is longer than any deploy blip
 * and far short of the minutes a draft legitimately takes.
 */
export const POLL_MAX_CONSECUTIVE_FAILURES = 10;

/**
 * What the screen says when it gives up watching. Deliberately about *this
 * screen* and not about the run: the run is a row advanced by its own
 * invocations and carries on regardless, which is the same thing
 * `STALE_RUN_ERROR` is careful to say about a worker that died.
 */
export const POLL_LOST_ERROR =
  "This screen lost contact with the server and stopped following the run. The run itself carries on; reload to pick it up.";

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
    initialRun?.run ? stateFromRun(initialRun.run, initialRun.article, { stale: initialRun.stale, drafts: initialRun.drafts }) : initialOnboardingState(),
  );
  // The site report, from the same snapshot the phases come from. Kept apart
  // from the reducer: it is a thing the run measured, not a step of the run.
  const [report, setReport] = useState<FirstLookReport | null>(initialRun?.report ?? null);
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

    let failures = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/onboard/state?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        if (res.ok) {
          const snapshot = (await res.json()) as OnboardingRunSnapshot;
          if (cancelled) return;
          if (snapshot.run) {
            failures = 0;
            const next = stateFromRun(snapshot.run, snapshot.article, { stale: snapshot.stale, drafts: snapshot.drafts });
            setState(next);
            if (snapshot.report) setReport(snapshot.report);
            if (isTerminal(next)) return;
          } else {
            failures += 1;
          }
        } else {
          failures += 1;
        }
      } catch {
        /* a missed poll is the next one's problem - until there are too many */
        failures += 1;
      }
      if (cancelled) return;
      // Without this the screen had no way to stop. Everything that decides a
      // run is over is read out of a successful response, so a session that
      // expired mid-run, or a route that started answering 500, left five
      // spinners turning and "This takes about a minute" on screen for as long
      // as the tab was open. The run itself is unaffected either way: it is a
      // row advanced by its own invocations, and this only ever watched it.
      if (failures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        fail(POLL_LOST_ERROR);
        return;
      }
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

      <RunLog steps={state.steps} />

      <CalendarStrip
        planned={state.planned}
        drafting={drafting?.status === "active"}
        article={state.article}
        skipped={drafting?.status === "skipped" || drafting?.status === "failed"}
        skippedReason={drafting?.status === "skipped" || drafting?.status === "failed" ? drafting.detail : undefined}
      />

      {/* What the first look measured, to read while the draft is written.
          It lands on the poll after the keywords phase, so for most of the
          wait it is on the screen; once the run is over it stays as the
          site's first report. */}
      <FirstLookReportView report={report} domain={domain} live={!finished} />
    </div>
  );
}

/**
 * The run, as a log that writes itself.
 *
 * Five rows with spinners said what stage the run was in and nothing about
 * what it was doing inside one, so the longest stages - the keyword work, the
 * draft - were a spinner for a minute and a half. A log reads as work being
 * done, and it has room for the detail each phase already reports.
 *
 * Fixed height on purpose: the panel must not grow as lines arrive, or the
 * trial ask above it walks down the page. It scrolls itself instead.
 *
 * Every line here is written for the person paying, not for us: what was read,
 * what was found, what was decided. Nothing names a provider, an endpoint, a
 * model or a table - the log is a window on the outcome, not on the plumbing.
 */
function RunLog({ steps }: { steps: OnboardingStep[] }) {
  const lines = useMemo(() => {
    const out: { text: string; kind: "cmd" | "out" }[] = [];
    for (const step of steps) {
      if (step.status === "pending") continue;
      out.push({ text: phaseLabel(step), kind: "cmd" });
      if (step.detail) out.push({ text: step.detail, kind: "out" });
    }
    return out;
  }, [steps]);

  // How many lines are fully written, and how much of the next one is.
  const [done, setDone] = useState(0);
  const [partial, setPartial] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  // A phase that rewrites its own detail (active -> done) can leave the
  // cursor past the end of a now-shorter list, so the cursor is derived and
  // never stored out of range.
  const cursor = Math.min(done, lines.length);

  useEffect(() => {
    if (cursor >= lines.length) return;
    const full = lines[cursor].text;
    // Someone who asked for less motion gets the whole line on the first
    // tick rather than a different code path.
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const step = reduced ? full.length : 2;
    let i = 0;
    const tick = setInterval(() => {
      i += step;
      if (i >= full.length) {
        clearInterval(tick);
        setPartial("");
        setDone(cursor + 1);
      } else {
        setPartial(full.slice(0, i));
      }
    }, 16);
    return () => clearInterval(tick);
  }, [cursor, lines]);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cursor, partial]);

  const written = lines.slice(0, cursor);
  const typing = cursor < lines.length;
  return (
    <div
      ref={box}
      role="log"
      aria-live="polite"
      aria-label="Setup progress"
      className="h-[196px] overflow-y-auto rounded-[8px] border border-line bg-bg px-3 py-2.5 font-mono text-[11.5px] leading-[1.7]"
    >
      {written.map((l, i) => (
        <div key={i} className={l.kind === "cmd" ? "text-ink" : "pl-3.5 text-ink-3"}>
          {l.kind === "cmd" && <span className="mr-1.5 text-accent">&gt;</span>}
          {l.text}
        </div>
      ))}
      {typing && (
        <div className={lines[cursor].kind === "cmd" ? "text-ink" : "pl-3.5 text-ink-3"}>
          {lines[cursor].kind === "cmd" && <span className="mr-1.5 text-accent">&gt;</span>}
          {partial}
          <span className="ml-px inline-block h-[11px] w-[6px] translate-y-[1px] animate-pulse bg-ink-3" />
        </div>
      )}
    </div>
  );
}

/**
 * The zone and locale every date on this screen is read in.
 *
 * UTC because the plan's dates are UTC. `en-US` and not the ambient locale
 * because this renders on the server first: Node's ICU default and the
 * browser's locale disagree ("18 Sept" against "Sep 18"), and React throws a
 * hydration mismatch on the difference. Every other date in the dashboard is
 * formatted the same way - `planner-grid.tsx:79` is the same call on the same
 * `YYYY-MM-DD` shape.
 */
const DATE_LOCALE = "en-US";
const DAY_LABEL: Intl.DateTimeFormatOptions = { weekday: "short", timeZone: "UTC" };
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };

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
                {d.toLocaleDateString(DATE_LOCALE, DAY_LABEL)}
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
          {dayFromIso(lastDate).toLocaleDateString(DATE_LOCALE, MONTH_DAY)}.
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
