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
// whoever wants them. Every row is a fixed height and every slot is drawn
// before it fills, so nothing moves under the person while they read.

import { useState } from "react";
import { Icons } from "@/components/ui";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";
import { PHASE_ORDER, type OnboardingPhase, type OnboardingState, type OnboardingStep } from "@/lib/onboarding/events";
import { clock, EXPECTED_GATE_S, leadingHeadline, leadingPhase, setupFraction } from "@/lib/onboarding/setup-progress";
import { ProgressBar, useNow } from "./progress-bar";
import { FirstLookReportView } from "./first-look-report";

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
  return parts.slice(0, count).join(" ").trim();
}

/** One line of what a phase is doing or found, for a person. Pure. */
export function phaseDetail(
  step: OnboardingStep,
  state: Pick<OnboardingState, "keywordsFound" | "planned">,
  report: FirstLookReport | null,
  tick: number,
): string {
  const { phase, status, detail } = step;
  if (status === "pending") return "";
  if (status === "skipped" || status === "failed") return sentences(detail, 1) || (status === "failed" ? "Did not finish." : "Skipped.");
  const active = status === "active";
  switch (phase) {
    case "scanning":
      return active ? "Reading your pages and how you write" : sentences(detail, 1) || "Learned how your site writes.";
    case "keywords":
      if (active) return "From what you sell, the competitors you named and what they rank for";
      return state.keywordsFound ? `${n(state.keywordsFound)} searches your buyers make` : sentences(detail, 1);
    case "pages":
      if (active) return "Reading the pages you already have";
      if (report?.existingPages) {
        const { checked, withIssues } = report.existingPages;
        return `${n(checked)} ${checked === 1 ? "page" : "pages"} read${withIssues ? `, ${n(withIssues)} with something to fix` : ", nothing to fix"}`;
      }
      return sentences(detail, 1);
    case "planning": {
      if (!active) {
        const planned = state.planned.length;
        return planned === 0 ? sentences(detail, 1) : planned === 1 ? "Your first article is on the calendar" : `${planned} articles on the calendar`;
      }
      const check = step.checking;
      if (check && check.terms.length) {
        const term = check.terms[tick % check.terms.length];
        return `Checking the results for “${term}”${check.judged ? ` · ${n(check.judged)} checked` : ""}`;
      }
      if (check && check.judged) return `${n(check.judged)} searches checked, ${n(check.qualified)} cleared the bar`;
      return "Reading the results pages for the searches that fit you best";
    }
    case "drafting": {
      if (!active) return sentences(detail, 1);
      if (detail) return detail.replace(/\s*(Writing|Outlining it) now\.$/, "").trim() || "Outlining it now";
      const topic = state.planned[0]?.term;
      return topic ? `Reading the pages that rank for “${topic}”` : "Reading the pages that rank for your first topic";
    }
  }
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

export function SetupLoading({
  domain,
  state,
  report,
  startedAt,
  log,
}: {
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
  const fraction = setupFraction(state.steps, elapsed);
  // The planning ticker steps through the batch's terms every 1.4 seconds.
  const tick = now ? Math.floor(now / 1400) : 0;
  const [openLog, setOpenLog] = useState(false);
  const firstTopic = state.planned[0]?.term ?? null;
  const planningSettled = state.steps.some((s) => s.phase === "planning" && s.status !== "pending" && s.status !== "active");

  return (
    <div className="mx-auto w-full max-w-[600px]">
      <div className="mb-6 text-center">
        <p className="m-0 mb-2 text-[12px] text-ink-3">Setting up {domain || "your site"}</p>
        <h1 className="m-0 text-[22px] font-semibold leading-tight" aria-live="polite">
          {leadingHeadline(leading, domain)}
        </h1>
        <p className="mx-auto m-0 mt-2 max-w-[440px] text-[13px] leading-[1.6] text-ink-2">
          Usually about a minute and a half. You can leave this page: the work carries on and this screen picks up where it is.
        </p>
      </div>

      <div className="rounded-[10px] border border-line bg-panel p-5">
        <div className="mb-4 flex flex-col gap-2">
          <ProgressBar fraction={fraction} label="Setup progress" />
          <div className="flex items-baseline justify-between text-[11.5px] text-ink-3">
            <span className="font-mono tabular-nums">{clock(elapsed)}</span>
            <span>usually about {clock(EXPECTED_GATE_S)}</span>
          </div>
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
                  <div className="truncate text-[12px] leading-[18px] text-ink-2" title={line || undefined}>
                    {line ? <span key={line} className="rise-in inline-block max-w-full truncate align-bottom">{line}</span> : " "}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Where the first article lands: drawn from the start, filled at the gate. */}
      <section aria-label="Your first article" className="mt-4 rounded-[10px] border border-dashed border-line bg-bg p-5">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-3">Your first article</div>
        <div className="mb-3 h-5 w-3/4 rounded-full bg-panel-2 motion-safe:animate-pulse" aria-hidden />
        <div className="flex flex-col gap-2" aria-hidden>
          {[88, 76, 82, 64].map((w) => (
            <span key={w} className="h-2.5 rounded-full bg-panel-2" style={{ width: `${w}%` }} />
          ))}
        </div>
        <p className="m-0 mt-3 text-[12.5px] text-ink-2">
          {firstTopic && planningSettled
            ? <>On “{firstTopic}”. Its title and sections land here in a few seconds.</>
            : "Chosen once we know which topics you can win. Its title and sections land here."}
        </p>
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
              ? `Your site report is ready${report.readiness ? ` · AI readability ${report.readiness.score}/100` : ""}`
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
