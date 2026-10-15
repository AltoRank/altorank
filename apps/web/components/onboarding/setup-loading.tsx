"use client";

// ---------------------------------------------------------------------------
// The first look, from the click to the gate: one calm screen
// ---------------------------------------------------------------------------
//
// What a person saw for the first 80-100 seconds before this (recorded
// 2026-10-12, site C): a six-line paragraph that said "a few minutes" over a
// card that said "about a minute"; an empty white box for five seconds; a
// monospace log that typed pipeline numbers into a box too small for them
// and scrolled them away; 19, then 30 to 40, seconds in which nothing moved;
// a site audit that pushed the page down half-way through.
//
// So the screen leads with what is happening now, in a sentence; a bar that
// walks with the clock and is held to what the run has reported
// (lib/onboarding/setup-progress.ts); the five phases, each with one line of
// what it found as it finds it - pages read, searches found, the topics
// being checked by name - and a slot, drawn from the start, where the first
// article lands. The log and the site report are still here, folded, for
// whoever wants them. Every slot is drawn before it fills and a phase's line
// holds two lines at most, so nothing moves under the person while they read.

import { useState } from "react";
import Link from "next/link";
import { Icons } from "@/components/ui";
import { readingBlockers, type FirstLookReport } from "@/lib/onboarding/first-look-report";
import { PHASE_ORDER, type OnboardingPhase, type OnboardingState, type OnboardingStep } from "@/lib/onboarding/events";
import type { PollRefusal } from "@/lib/onboarding/poll-backoff";
import { clock, estimateLine, firstLookFraction, leadingHeadline, leadingPhase, runningLong } from "@/lib/onboarding/setup-progress";
import { ProgressBar, useNow } from "./progress-bar";
import { useReducedMotion } from "./use-first-article-live";
import { FirstLookReportView } from "./first-look-report";
import { EmailWhenReady } from "./first-look-exits";

const PHASE_NAME: Record<OnboardingPhase, string> = {
  scanning: "Read your site",
  keywords: "Find what your buyers search for",
  pages: "Check your existing pages",
  planning: "Pick the topics you can win",
  drafting: "Outline your first article",
};

const n = (x: number) => x.toLocaleString("en-US");

/** The first `count` sentences of a phase's own detail. */
function sentences(text: string | undefined, count: number): string {
  const parts = (text ?? "").match(/[^.!?]+[.!?]+/g) ?? (text ? [text] : []);
  return parts.slice(0, count).map((p) => p.trim()).join(" ");
}

/**
 * "40 pages read, 25 with something to fix", from the pages phase's own
 * sentence ("Read 40 pages. Found 49 technical issues on 25 of them.").
 * The one source for the line: it used to switch to the site report's count
 * once that landed, so the same row read "Read 40 pages…" and then "39 pages
 * read…" (review, 2026-10-12). Null when the sentence is not that shape.
 */
export function pagesLine(detail: string | undefined): string | null {
  const read = detail?.match(/^Read ([\d,]+) pages?\./);
  if (!read) return null;
  const count = Number(read[1].replace(/,/g, ""));
  const fix = detail!.match(/technical issues? on ([\d,]+) of them/);
  const withIssues = fix ? Number(fix[1].replace(/,/g, "")) : 0;
  return `${n(count)} ${count === 1 ? "page" : "pages"} read${withIssues ? `, ${n(withIssues)} with something to fix` : ", nothing to fix"}`;
}

/**
 * One line of what a phase is doing or found, for a person. Pure.
 *
 * `tick` steps the planning line through the searches being checked; null
 * (less motion asked for) holds it on the counts instead, with no term
 * changing under the person every second and a half.
 */
export function phaseDetail(
  step: OnboardingStep,
  state: Pick<OnboardingState, "keywordsFound" | "planned">,
  report: FirstLookReport | null,
  tick: number | null,
): string {
  const { phase, status, detail } = step;
  if (status === "pending") return "";
  if (status === "skipped" || status === "failed") return sentences(detail, 1) || (status === "failed" ? "Did not finish." : "Skipped.");
  const active = status === "active";
  switch (phase) {
    case "scanning":
      return active ? "Reading your pages and how you write" : sentences(detail, 1) || "Learned how your site writes.";
    case "keywords":
      if (active) return "From what you sell and what your competitors rank for";
      return state.keywordsFound ? `${n(state.keywordsFound)} searches your buyers make` : sentences(detail, 1);
    case "pages":
      if (active) return "Reading the pages you already have";
      {
        const line = pagesLine(detail);
        if (line) return line;
      }
      if (report?.existingPages) {
        const { checked, withIssues } = report.existingPages;
        return `${n(checked)} ${checked === 1 ? "page" : "pages"} read${withIssues ? `, ${n(withIssues)} with something to fix` : ", nothing to fix"}`;
      }
      return sentences(detail, 2);
    case "planning": {
      if (!active) {
        const planned = state.planned.length;
        return planned === 0 ? sentences(detail, 1) : planned === 1 ? "Your first article is on the calendar" : `${planned} articles on the calendar`;
      }
      const check = step.checking;
      if (check && check.terms.length && tick === null) {
        return check.judged ? `${n(check.judged)} searches checked, ${n(check.qualified)} cleared the bar` : "Checking the results pages for the searches that fit you best";
      }
      if (check && check.terms.length && tick !== null) {
        const term = check.terms[tick % check.terms.length];
        return `Checking the results for “${term}”${check.judged ? ` · ${n(check.judged)} checked` : ""}`;
      }
      if (check && check.judged) return `${n(check.judged)} searches checked, ${n(check.qualified)} cleared the bar`;
      return "Checking the results pages for the searches that fit you best";
    }
    case "drafting": {
      if (!active) return sentences(detail, 1);
      if (detail) return detail.replace(/\s*(Writing|Outlining it) now\.$/, "").trim() || "Outlining it now";
      const topic = state.planned[0]?.term;
      return topic ? `Reading the pages that rank for “${topic}”` : "Reading the pages that rank for your first topic";
    }
  }
}

/**
 * What the screen can already tell the person while the topic is chosen:
 * two or three facts the first look has measured, in plain words. The centre
 * of this screen was a grey skeleton for ninety seconds while the one real
 * payoff - the site report - sat folded below the fold (UX audit
 * 2026-10-12). No scores: a number out of 100 beside "pages to fix"
 * contradicted itself with no explanation.
 */
export function waitingFacts(state: Pick<OnboardingState, "keywordsFound" | "steps">, report: FirstLookReport | null): string[] {
  const out: string[] = [];
  const pages = report?.existingPages ?? null;
  const read = pages?.checked ?? report?.pagesCrawled ?? 0;
  if (read > 0) out.push(`${n(read)} ${read === 1 ? "page" : "pages"} of your site read`);
  if (state.keywordsFound) out.push(`${n(state.keywordsFound)} searches your customers make`);
  if (pages && pages.withIssues > 0) out.push(`${n(pages.withIssues)} existing ${pages.withIssues === 1 ? "page" : "pages"} with something to fix`);
  // The same predicate as the report's line: only what really stops an AI assistant reading the site.
  if (out.length < 3 && readingBlockers(report) > 0) out.push("Some AI assistants are blocked from reading your site");
  return out.slice(0, 3);
}

function StatusMark({ status }: { status: OnboardingStep["status"] }) {
  if (status === "done") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-soft text-ok-ink" aria-hidden>
        <Icons.check size={11} />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden>
        <span className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent motion-safe:animate-spin" />
      </span>
    );
  }
  if (status === "skipped" || status === "failed") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-ink-3" aria-hidden>
        <span className="h-0.5 w-2 rounded-full bg-ink-4" />
      </span>
    );
  }
  return <span className="h-5 w-5 shrink-0 rounded-full border border-line" aria-hidden />;
}

const STATUS_WORD: Record<OnboardingStep["status"], string> = {
  pending: "to do",
  active: "in progress",
  done: "done",
  skipped: "skipped",
  failed: "did not finish",
};

/**
 * What the screen says once the server has refused to show the run: it has
 * stopped watching, the run has not stopped, and the one thing to do.
 */
export function PollRefusedLine({ refused }: { refused: PollRefusal }) {
  return (
    <p role="alert" className="m-0 mt-1 text-[12.5px] leading-[1.5] text-ink-2">
      {refused === "signed-out" ? (
        <>
          You were signed out, so this screen stopped following setup. Setup carries on without it.{" "}
          <Link href="/signin?next=%2Fonboarding" className="text-ink underline decoration-line underline-offset-[3px]">
            Sign in again
          </Link>{" "}
          to see it.
        </>
      ) : (
        "This account can no longer see this site's setup, so this screen stopped following it."
      )}
    </p>
  );
}

export function SetupLoading({
  workspaceId,
  domain,
  state,
  report,
  startedAt,
  log,
  reconnecting = false,
  refused = null,
}: {
  workspaceId: string;
  /** The screen has lost the server for a few polls and is trying again; the run is not over. */
  reconnecting?: boolean;
  /** The server refused to show the run (signed out, no longer a member): the screen stopped watching. */
  refused?: PollRefusal | null;
  domain: string;
  state: OnboardingState;
  report: FirstLookReport | null;
  /** When the run started, on this browser's clock (server skew removed); null until known. */
  startedAt: number | null;
  /** The run's own log, folded away below. */
  log: React.ReactNode;
}) {
  const now = useNow(500, true);
  const elapsed = now && startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const leading = leadingPhase(state.steps);
  // One bar and one clock, from the click to the written article: this is
  // the first part of it, and the gate's article card carries on from here.
  const fraction = firstLookFraction(state.steps, elapsed);
  const long = startedAt !== null && runningLong(elapsed, false);
  const facts = waitingFacts(state, report);
  // The planning ticker steps through the batch's terms every 3.5 seconds:
  // at 1.4 it flipped faster than a term could be read. With less motion
  // asked for it holds on the counts (`phaseDetail`).
  const reduced = useReducedMotion();
  const tick = reduced ? null : now ? Math.floor(now / 3500) : 0;
  const [openLog, setOpenLog] = useState(false);
  const firstTopic = state.planned[0]?.term ?? null;
  const planningSettled = state.steps.some((s) => s.phase === "planning" && s.status !== "pending" && s.status !== "active");
  const siteRead = state.steps.some((s) => s.phase === "scanning" && s.status !== "pending" && s.status !== "active");

  return (
    <div className="mx-auto w-full">
      <div className="mb-6 text-center">
        <p className="m-0 mb-2 text-[12px] text-ink-3">Setting up {domain || "your site"}</p>
        <h1 className="m-0 text-[22px] font-semibold leading-tight [text-wrap:balance]" aria-live="polite">
          {leadingHeadline(leading, domain)}
        </h1>
        <p className="mx-auto m-0 mt-2 max-w-[440px] text-[13px] leading-[1.6] text-ink-2 [text-wrap:balance]">
          You can leave this page: the work carries on and this screen picks up where it is.
        </p>
      </div>

      <div className="rounded-[10px] border border-line bg-panel p-5">
        <div className="mb-4 flex flex-col gap-2">
          <ProgressBar fraction={fraction} label="Setup progress" />
          <div className="flex items-baseline justify-between text-[11.5px] text-ink-3">
            <span className="font-mono tabular-nums">{clock(elapsed)}</span>
            <span className={long ? "text-ink-2" : undefined}>{estimateLine(elapsed, false)}</span>
          </div>
          {refused ? (
            <PollRefusedLine refused={refused} />
          ) : reconnecting ? (
            <p role="status" className="m-0 text-[12px] text-ink-2">
              Reconnecting… The work carries on while this screen catches up.
            </p>
          ) : null}
          {long && (
            <div className="flex flex-col gap-1 rounded-[8px] border border-line bg-bg px-3 py-2.5 text-[12.5px] text-ink-2">
              <span>This one is taking longer than usual. You can leave: the work carries on without this page.</span>
              <EmailWhenReady workspaceId={workspaceId} className="self-start" />
            </div>
          )}
        </div>

        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="What setup is doing">
          {PHASE_ORDER.map((phase) => {
            const step = state.steps.find((s) => s.phase === phase) ?? { phase, status: "pending" as const };
            const line = phaseDetail(step, state, report, tick);
            return (
              <li key={phase} className="flex min-h-[38px] items-start gap-3">
                <StatusMark status={step.status} />
                <div className="min-w-0 flex-1">
                  <div className={`text-[13.5px] leading-5 ${step.status === "pending" ? "text-ink-3" : "text-ink"} ${step.status === "active" ? "font-medium" : ""}`}>
                    {PHASE_NAME[phase]}
                    <span className="sr-only">: {STATUS_WORD[step.status]}</span>
                  </div>
                  {/* Two lines at most: a narrow screen cut the active line
                      to "From what you sell, the competitors you named a…". */}
                  <div className="text-[12px] leading-[18px] text-ink-2" title={line || undefined}>
                    {line ? <span key={line} className="rise-in line-clamp-2 block max-w-full">{line}</span> : " "}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Where the first article lands: the chosen topic once there is one,
          and until then what the first look has already found. */}
      <section aria-label="Your first article" className="mt-4 rounded-[10px] border border-dashed border-line bg-bg p-5">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-3">Your first article</div>
        {firstTopic && planningSettled ? (
          <>
            <p key={firstTopic} className="rise-in m-0 text-[17px] font-semibold leading-snug text-ink">On “{firstTopic}”</p>
            <p className="m-0 mt-2 text-[12.5px] text-ink-2">
              The topic your buyers search for that you can win first. Its title and sections land here {long ? "next" : "in a few seconds"}.
            </p>
          </>
        ) : facts.length > 0 ? (
          <>
            <p className="m-0 mb-2.5 text-[12.5px] text-ink-2">Chosen once we know which topics you can win. So far:</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {facts.map((fact) => (
                <li key={fact} className="rise-in flex items-start gap-2 text-[13.5px] leading-[1.5] text-ink">
                  <span className="mt-[3px] shrink-0 text-ok-ink" aria-hidden>
                    <Icons.check size={12} />
                  </span>
                  {fact}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="mb-3 h-5 w-3/4 rounded-full bg-panel-2 motion-safe:animate-pulse" aria-hidden />
            <p className="m-0 text-[12.5px] text-ink-2">Chosen once we know which topics you can win. Its title and sections land here.</p>
          </>
        )}
      </section>

      <details className="group mt-4 rounded-[10px] border border-line bg-panel" open={openLog} onToggle={(e) => setOpenLog((e.target as HTMLDetailsElement).open)}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-[12.5px] text-ink-2 [&::-webkit-details-marker]:hidden">
          <span>Every step, as it happens</span>
          <span className="text-ink-3 transition-transform group-open:rotate-180"><Icons.caretDown size={12} /></span>
        </summary>
        <div className="border-t border-line px-5 py-4">{log}</div>
      </details>

      <details className="group mt-2 rounded-[10px] border border-line bg-panel">
        <summary
          className={`flex list-none items-center justify-between gap-3 px-5 py-3 text-[12.5px] [&::-webkit-details-marker]:hidden ${report ? "cursor-pointer text-ink-2" : "pointer-events-none text-ink-3"}`}
          aria-disabled={!report}
          tabIndex={report ? undefined : -1}
        >
          <span>
            {report
              ? `Your site report is ready${report.existingPages?.withIssues ? ` · ${report.existingPages.withIssues} ${report.existingPages.withIssues === 1 ? "page" : "pages"} with something to fix` : ""}`
              : siteRead
                ? "Your site report · being put together"
                : "Your site report · ready once your site is read"}
          </span>
          {report && <span className="text-ink-3 transition-transform group-open:rotate-180"><Icons.caretDown size={12} /></span>}
        </summary>
        {report && (
          <div className="border-t border-line px-5 py-4">
            <FirstLookReportView report={report} domain={domain} live />
          </div>
        )}
      </details>
    </div>
  );
}
