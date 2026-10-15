"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FirstLookReportView } from "./first-look-report";
import { PollRefusedLine, SetupLoading } from "./setup-loading";
import { Fold } from "./fold";
import { readingBlockers, type FirstLookReport } from "@/lib/onboarding/first-look-report";
import { calendarStripDays, dayFromIso, MAX_CHIPS_PER_DAY } from "@/lib/onboarding/calendar-strip";
import { nextPollDelay, pollRefusal, REFUSALS_TO_STOP, reconnecting as isReconnecting, type PollRefusal } from "@/lib/onboarding/poll-backoff";
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
export function OnboardingProgress({
  workspaceId,
  domain,
  onDone,
  nextHref,
  autoNavigate = true,
  onState,
  initialRun = null,
  lockHeld = false,
  preTrial = false,
  variant = "log",
  refreshKey = 0,
  scheduled,
  onStartedAt,
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
  /** Draw the topics held for the trial as locked squares on the strip. */
  lockHeld?: boolean;
  /**
   * The account has not started its trial: its first draft is written but
   * not readable, so nothing here may point it at a review queue.
   */
  preTrial?: boolean;
  /**
   * `log`: the run as a log, a calendar and the site report, as the
   * dashboard and self-hosted installs show it. `first-look`: while the run
   * is live, the focused loading screen (./setup-loading.tsx); once it is
   * over, the same three folded away under the gate.
   */
  variant?: "log" | "first-look";
  /**
   * Bumped by the gate when the first article's body lands after the run
   * ended at its outline: the row is read once more, so the log says what
   * was written instead of "being written now".
   */
  refreshKey?: number;
  /** The scheduled list the gate shows inside the folded calendar. */
  scheduled?: React.ReactNode;
  /** Told when the run's start is known, on this browser's clock: the gate's clock carries on from it. */
  onStartedAt?: (ms: number) => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(() =>
    initialRun?.run ? stateFromRun(initialRun.run, initialRun.article, { stale: initialRun.stale, drafts: initialRun.drafts, held: initialRun.held }) : initialOnboardingState(),
  );
  // The site report, from the same snapshot the phases come from. Kept apart
  // from the reducer: it is a thing the run measured, not a step of the run.
  const [report, setReport] = useState<FirstLookReport | null>(initialRun?.report ?? null);
  // When the run started, on this browser's clock: the row's start, moved by
  // how far the server's clock is from this one (/state answers its `now`).
  const [startedAt, setStartedAt] = useState<number | null>(() => (initialRun?.run ? Date.parse(initialRun.run.started_at) : null));
  // `onDone` is a fresh arrow on every parent render. Reading it through a ref
  // keeps it out of the hand-off effect's dependencies, so a parent re-render
  // - the workspace list refreshing after creation, for one - cannot re-run
  // that effect and clear its timer.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const settledOnMount = Boolean(initialRun?.run && (initialRun.run.status !== "running" || initialRun.stale));
  // A connection that keeps failing is said, and never ends the run on this
  // screen: only the server's answer can (lib/onboarding/poll-backoff.ts).
  const [reconnecting, setReconnecting] = useState(false);
  // The server refused the poll (signed out, or no longer a member): the
  // screen stops watching and says so. The run itself carries on.
  const [refused, setRefused] = useState<PollRefusal | null>(null);

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
    let refusals = 0;
    let running = false;
    let started = false;

    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(started ? poll : start, nextPollDelay(failures, Date.now() - startedAt));
    };
    const missed = () => {
      failures += 1;
      setReconnecting(isReconnecting(failures));
    };

    const poll = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        const res = await fetch(`/api/onboard/state?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        const refusal = res.ok ? null : pollRefusal(res.status);
        refusals = refusal ? refusals + 1 : 0;
        if (refusal && refusals >= REFUSALS_TO_STOP) {
          // An answer, not a blip: stop asking (the tab coming back must not
          // start it again), and say why.
          cancelled = true;
          setReconnecting(false);
          setRefused(refusal);
          return;
        }
        if (res.ok) {
          const snapshot = (await res.json()) as OnboardingRunSnapshot;
          if (cancelled) return;
          if (snapshot.run) {
            failures = 0;
            setReconnecting(false);
            const next = stateFromRun(snapshot.run, snapshot.article, { stale: snapshot.stale, drafts: snapshot.drafts, held: snapshot.held });
            setState(next);
            const serverNow = (snapshot as { now?: number }).now;
            const skew = typeof serverNow === "number" ? serverNow - Date.now() : 0;
            const startedRun = Date.parse(snapshot.run.started_at);
            if (Number.isFinite(startedRun)) setStartedAt(startedRun - skew);
            if (snapshot.report) setReport(snapshot.report);
            if (isTerminal(next)) return;
          } else {
            missed();
          }
        } else {
          missed();
        }
      } catch {
        // A missed poll - a phone between networks, a deploy - is never the
        // end of the run (a signed-out tab is the server's answer, above). The run carries on regardless:
        // it is a row advanced by its own invocations, and this only watches.
        missed();
      } finally {
        running = false;
      }
      schedule();
    };

    // Start (or find) the run. A refusal the server writes ends the screen
    // with its sentence; a request that never arrived is tried again.
    const start = async () => {
      if (cancelled || running) return;
      running = true;
      let refusal: string | null = null;
      try {
        const res = await fetch("/api/onboard/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
        if (cancelled) return;
        if (res.ok) {
          started = true;
          failures = 0;
          setReconnecting(false);
        } else if (res.status < 500) {
          // The route's refusal is a sentence written for this screen - the
          // spend gate's, when setup has already run before the trial - and
          // a bare status code in its place told the person nothing.
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          refusal = body?.error ?? `Onboarding could not start (${res.status}).`;
        } else {
          missed();
        }
      } catch {
        missed();
      } finally {
        running = false;
      }
      if (cancelled) return;
      if (refusal) {
        fail(refusal);
        return;
      }
      if (started) await poll();
      else schedule();
    };

    // Back on the tab: ask now rather than at the end of a long backoff.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      if (timer) clearTimeout(timer);
      void (started ? poll() : start());
    };
    document.addEventListener("visibilitychange", onVisible);

    void start();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
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
  // The parent passes a state setter, which is stable.
  useEffect(() => {
    if (startedAt !== null) onStartedAt?.(startedAt);
  }, [startedAt, onStartedAt]);
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(() => {
      onDoneRef.current?.();
      if (autoNavigate) router.push(nextHref ?? `/workspaces/${workspaceId}`);
    }, HANDOFF_MS);
    return () => clearTimeout(t);
  }, [finished, router, workspaceId, nextHref, autoNavigate]);

  // Read the row once more when the gate says the body has landed.
  useEffect(() => {
    if (!refreshKey) return;
    let cancelled = false;
    fetch(`/api/onboard/state?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<OnboardingRunSnapshot>) : null))
      .then((snapshot) => {
        if (cancelled || !snapshot?.run) return;
        setState(stateFromRun(snapshot.run, snapshot.article, { stale: snapshot.stale, drafts: snapshot.drafts, held: snapshot.held }));
        if (snapshot.report) setReport(snapshot.report);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey, workspaceId]);

  const drafting = state.steps.find((s) => s.phase === "drafting");
  // The closing sentence is derived, not chosen: `ready` is emitted whatever
  // happened, so "Done. Your first month is on the calendar" used to print
  // over an empty calendar and a refused draft.
  const outcome = onboardingOutcome(state, autoNavigate, { preTrial });

  const calendar = (
    <CalendarStrip
      planned={state.planned}
      heldDates={lockHeld ? state.held?.dates ?? [] : []}
      drafting={drafting?.status === "active"}
      article={state.article}
      skipped={drafting?.status === "skipped" || drafting?.status === "failed"}
      skippedReason={drafting?.status === "skipped" || drafting?.status === "failed" ? drafting.detail : undefined}
      preTrial={preTrial}
    />
  );

  if (variant === "first-look") {
    if (!finished) {
      return <SetupLoading workspaceId={workspaceId} domain={domain} state={state} report={report} startedAt={startedAt} reconnecting={reconnecting} refused={refused} log={<RunLog steps={state.steps} preTrial={preTrial} />} />;
    }
    const scheduledCount = state.planned.length;
    const heldCount = lockHeld ? state.held?.count ?? 0 : 0;
    return (
      <div className="flex flex-col gap-2">
        <Fold title="How setup went" line={outcome.line} tone={outcome.tone === "error" ? "err" : undefined}>
          <RunLog steps={state.steps} preTrial={preTrial} />
        </Fold>
        {scheduledCount > 0 && (
          <Fold
            title="Your calendar"
            line={`${scheduledCount} ${scheduledCount === 1 ? "article" : "articles"} scheduled${heldCount ? `, ${heldCount} more ready for your trial` : ""}`}
          >
            {calendar}
            {scheduled}
          </Fold>
        )}
        {report && (
          <Fold title="Your site report" line={reportLine(report, domain)}>
            <FirstLookReportView report={report} domain={domain} live={false} />
          </Fold>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" aria-live="polite">
      <div>
        <div className="text-[13px] font-medium text-ink">Setting up {domain}</div>
        <p
          className={`m-0 mt-1 text-[12.5px] leading-relaxed ${outcome.tone === "error" ? "text-err-ink" : "text-ink-2"}`}
        >
          {outcome.line}
        </p>
        {refused && !finished ? (
          <PollRefusedLine refused={refused} />
        ) : reconnecting && !finished ? (
          <p role="status" className="m-0 mt-1 text-[12px] text-ink-3">
            Reconnecting… The run carries on while this screen catches up.
          </p>
        ) : null}
      </div>

      <RunLog steps={state.steps} />

      {calendar}

      {/* What the first look measured, to read while the draft is written.
          It lands on the poll after the keywords phase, so for most of the
          wait it is on the screen; once the run is over it stays as the
          site's first report. */}
      <FirstLookReportView report={report} domain={domain} live={!finished} />
    </div>
  );
}

/**
 * The site report's one line, leading with what there is to fix and with no
 * score: "AI readability 96/100" beside "25 pages with something to fix"
 * contradicted itself with no explanation (UX audit 2026-10-12, #8). The
 * score is inside, with what it measures.
 */
export function reportLine(report: FirstLookReport, domain: string): string {
  const pages = report.existingPages?.withIssues ?? 0;
  // Only what really stops an AI assistant reading the site; advice is in the report.
  const blocked = readingBlockers(report) > 0;
  const parts = [
    pages > 0 ? `${pages} existing ${pages === 1 ? "page" : "pages"} with something to fix` : null,
    blocked ? "some AI assistants are blocked from reading it" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${domain || "Your site"}, as we read it`;
}

/**
 * A phase's own sentence, for an account before its trial: without the
 * pointers to dashboard pages the gate does not open yet ("Add a keyword by
 * hand from Keywords", "see Keywords"), which redirected straight back here.
 */
export function preTrialDetail(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  const out = detail
    .replace(/\s*Add a keyword by hand from Keywords, or connect Search Console, and the plan can be built from there\./g, "")
    .replace(/;\s*see Keywords(?=[.)]|$)/g, "")
    .trim();
  return out || undefined;
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
function RunLog({ steps, preTrial = false }: { steps: OnboardingStep[]; preTrial?: boolean }) {
  const lines = useMemo(() => {
    const out: { text: string; kind: "cmd" | "out" }[] = [];
    for (const step of steps) {
      if (step.status === "pending") continue;
      out.push({ text: phaseLabel(step), kind: "cmd" });
      const detail = preTrial ? preTrialDetail(step.detail) : step.detail;
      if (detail) out.push({ text: detail, kind: "out" });
    }
    return out;
  }, [steps, preTrial]);

  // How many lines are fully written, and how much of the next one is. The
  // lines already there when the log first renders are shown whole: on a
  // reload of a finished run it retyped every line for seven seconds, as if
  // setup were running again (recorded 2026-10-12). Only new lines type.
  const [done, setDone] = useState(() => lines.length);
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
      {/* The line being typed is not read out character by character: the
          live region announces it once, when it is whole. */}
      {typing && (
        <div aria-hidden className={lines[cursor].kind === "cmd" ? "text-ink" : "pl-3.5 text-ink-3"}>
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
  heldDates,
  drafting,
  article,
  skipped,
  skippedReason,
  preTrial = false,
}: {
  planned: OnboardingState["planned"];
  /** Days a held topic would take; drawn as a locked chip, no term. */
  heldDates?: string[];
  drafting: boolean;
  article: OnboardingState["article"];
  skipped: boolean;
  skippedReason?: string;
  preTrial?: boolean;
}) {
  const { days, beyond, lastDate, draftDate } = calendarStripDays(planned);
  const heldOn = new Map<string, number>();
  for (const d of heldDates ?? []) heldOn.set(d, (heldOn.get(d) ?? 0) + 1);

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Your calendar</div>
      {/* Seven columns do not fit a phone: the week scrolls inside its own
          box there rather than squeezing every label to a letter. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <div className="grid min-w-[504px] grid-cols-7 gap-1" role="presentation">
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
              {(heldOn.get(day.date) ?? 0) > 0 && (
                <div
                  className="mt-1 truncate rounded-sm border border-dashed border-line px-1 py-0.5 text-[10.5px] leading-tight text-ink-3"
                  title="A topic held for the trial"
                >
                  {(heldOn.get(day.date) ?? 0) > 1 ? `${heldOn.get(day.date)} held` : "Held for trial"}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </div>
      {beyond > 0 && lastDate && (
        <p className="m-0 mt-2 text-[12px] text-ink-3">
          and {beyond} more on the calendar through{" "}
          {dayFromIso(lastDate).toLocaleDateString(DATE_LOCALE, MONTH_DAY)}.
        </p>
      )}
      {article && (
        <p className="m-0 mt-2 text-[12px] text-ink-2">
          {preTrial ? (
            // True with PRETRIAL_FULL_ARTICLE either way: the owner may be
            // reading it already, and approving and publishing wait for the
            // trial whatever the switch says.
            article.outlined
              ? "First article is outlined and being written. Approving and publishing it open with the trial."
              : "First article is written. Approving and publishing it open with the trial."
          ) : (
            <>
              First draft is in your review queue
              {article.verdict === "high_risk"
                ? " with figures to check before publishing"
                : article.verdict === "unchecked"
                  ? "; nothing in it was fact-checked, so read it against its sources before publishing"
                  : ""}
              .
            </>
          )}
        </p>
      )}
      {skipped && skippedReason && (
        <p className="m-0 mt-2 text-[12px] text-ink-3">{skippedReason}</p>
      )}
    </div>
  );
}
