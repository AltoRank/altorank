"use client";

// ---------------------------------------------------------------------------
// One planned keyword on the calendar
// ---------------------------------------------------------------------------
//
// The square shows the keyword as an object - shape, volume, difficulty - and
// lets the person do what a plan is for: write it now, tell the writer
// something, answer its questions, move the day, take it off. Which of those
// it offers follows one state machine, lib/plan/card-state.ts:
//
//   planned → writing → in review → approved / scheduled → live
//
// Two other squares share this component and the same machine. An
// improvement - a scheduled rewrite of a page that already ranks - shows the
// page and the reason, and opens Improvements; it moves and unschedules
// through the same actions the Improvements page uses. A frozen keyword -
// beyond what the plan allows - is greyed with the reason on it and offers
// only Remove, singly or with every other inactive keyword at once.
//
// Actions live in a hover row so the grid stays a calendar rather than a
// toolbar. "—" wherever a number or a state is unknown: volume 0 from a
// provider is a measurement; a null difficulty is not, and rendering it as 0
// is the green-zero bug again.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Avatar, Button, Dialog, Icons, StatusPill } from "@/components/ui";
import type { CalendarEntry } from "@/lib/types";
import type { PlannerKeyword } from "@/lib/queries/keywords";
import { taxonomyLabel, EXPECTED_LENGTHS, LENGTH_LABELS } from "@/lib/keywords/taxonomy";
import { parseStoredQuestions, unansweredCount, type QualityQuestion } from "@/lib/keywords/questions";
import { plannerCardState, cardActions, cardStatusPill, type ArticleFacts } from "@/lib/plan/card-state";
import { OPPORTUNITY_LABELS } from "@/lib/refresh/types";
import type { PlannerImprovement } from "@/lib/queries/improvements";
import { POLL_MS, GIVE_UP_MS } from "@/components/dashboard/first-draft-live";
import {
  ensureKeywordQuestions,
  removeInactiveEntries,
  removePlannedEntry,
  reschedulePlannedEntry,
  saveKeywordAnswers,
  saveKeywordBrief,
} from "@/app/actions/plan";
import { cancelTask, scheduleCandidate } from "@/app/actions/refresh";

/** Whether "Write now" may run, and if not, why. Decided by the page from the quota. */
export type WriteGate = { ok: true } | { ok: false; reason: string };

function num(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : "—";
}

type Dlg = null | "instructions" | "questions" | "move" | "remove";

const toolBtn = "w-6 h-6 inline-grid place-items-center rounded-[5px] text-ink-3 hover:bg-panel-2 disabled:opacity-50 disabled:hover:bg-transparent";

export function PlannerCard({
  entry,
  keyword,
  workspace,
  article,
  inFlight,
  frozen = null,
  frozenCount = 0,
  improvement = null,
  now,
  writeGate,
  drag,
}: {
  entry: CalendarEntry;
  keyword: PlannerKeyword | null;
  workspace: { initials: string; color: string; domain: string | null } | null;
  article: ArticleFacts;
  inFlight: { createdAt: string; phase: "research" | "drafting" } | null;
  /** Why this planned keyword is inactive under the plan; null when it is not. */
  frozen?: string | null;
  /** How many keywords on this site are inactive, so Remove can offer all of them. */
  frozenCount?: number;
  /** Present when the square is a scheduled rewrite; `entry` is then a stand-in whose id is the task's. */
  improvement?: PlannerImprovement | null;
  /** Server clock at render, so a stalled draft reads as stalled after a reload too. */
  now: number;
  writeGate: WriteGate;
  drag?: {
    /** Why this card does not drag, or null when it does. */
    blocked: string | null;
    handleRef: (el: HTMLElement | null) => void;
    handleProps: Record<string, unknown>;
  };
}) {
  const router = useRouter();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set the moment "Write now" is pressed, cleared when the server confirms the
  // draft exists (the card reads "writing" from props) or the run settles.
  const [starting, setStarting] = useState(false);

  const [instructions, setInstructions] = useState(keyword?.instructions ?? "");
  const [expectedLength, setExpectedLength] = useState(keyword?.expected_length ?? "auto");
  const [questions, setQuestions] = useState<QualityQuestion[]>(parseStoredQuestions(keyword?.quality_questions));
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [date, setDate] = useState(entry.scheduled_date.slice(0, 10));
  // "Remove" on a frozen card: this one, or every inactive keyword.
  const [removeScope, setRemoveScope] = useState<"one" | "all">("one");

  const serverState = plannerCardState(entry, article, inFlight !== null, {
    frozen: frozen !== null,
    improvement: improvement ? { status: improvement.status } : undefined,
  });
  const state = starting && serverState === "planned" ? "writing" : serverState;
  const actions = cardActions(state);
  const pill = cardStatusPill(state);
  const stalled = inFlight !== null && now - new Date(inFlight.createdAt).getTime() > GIVE_UP_MS;

  const label = taxonomyLabel(keyword?.article_subtype);
  const unanswered = unansweredCount(questions);
  const hasInstructions = Boolean(keyword?.instructions?.trim());
  const draftHref = entry.article_id ? `/content/${entry.article_id}` : null;
  const improvementHref = improvement
    ? improvement.executionId && state === "improved"
      ? `/improvements/${improvement.executionId}`
      : "/improvements"
    : null;

  // Move and Remove go through whichever door owns the row: the plan's
  // actions for a keyword, the Improvements page's for a rewrite. Same
  // behaviour as those screens, because it is the same code.
  const move = (to: string) => (improvement ? scheduleCandidate(improvement.candidateId, to) : reschedulePlannedEntry(entry.id, to));
  const remove = () =>
    improvement
      ? cancelTask(improvement.taskId)
      : state === "frozen" && removeScope === "all"
        ? removeInactiveEntries()
        : removePlannedEntry(entry.id);

  // While a draft is in flight, ask the server again every few seconds, the
  // way the overview does for the first draft. Stops on its own once the run
  // has gone quiet for ten minutes.
  useEffect(() => {
    if (state !== "writing" || stalled) return;
    const t = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [state, stalled, router]);

  // Once the server says the draft exists, the local "starting" flag has done
  // its job. Adjusted during render rather than in an effect (react.dev:
  // "storing information from previous renders").
  const [seenServerState, setSeenServerState] = useState(serverState);
  if (serverState !== seenServerState) {
    setSeenServerState(serverState);
    if (serverState !== "planned") setStarting(false);
  }

  // Generate questions the first time the dialog opens on an empty row, and
  // again on "Try again".
  function loadQuestions() {
    if (!keyword || generating) return;
    setError(null);
    setGenerating(true);
    ensureKeywordQuestions(keyword.id)
      .then((qs) => setQuestions(qs))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not generate questions."))
      .finally(() => setGenerating(false));
  }

  async function act(fn: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await fn();
      setDlg(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  // A fetch, not the `writeNow` server action: a server action that runs for
  // minutes holds the router's action queue, and with it the router.refresh()
  // above that shows progress. Same behaviour behind both doors.
  async function startWriting() {
    if (!writeGate.ok) return;
    setError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/plan/write-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: entry.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not start the draft.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the draft.");
      setStarting(false);
    }
  }

  const openDlg = (d: Dlg) => {
    setError(null);
    setDlg(d);
    if (d === "questions" && questions.length === 0) loadQuestions();
  };

  return (
    <div
      className={`group text-xs relative ${
        improvement ? "border-l-2 border-accent pl-2 -ml-0.5" : ""
      } ${state === "frozen" ? "opacity-60" : ""}`}
      data-state={state}
    >
      {workspace && (
        <div className="flex items-center gap-1.5 mb-1.5">
          <Avatar initials={workspace.initials} color={workspace.color} size="sm" className="w-4 h-4 text-[8px] rounded" />
          <span className="font-mono text-[10px] text-ink-3 truncate">{workspace.domain}</span>
        </div>
      )}
      {improvement ? (
        <>
          <div className="flex items-center gap-1 text-xs text-ink leading-[1.35]">
            <Icons.refresh size={11} className="shrink-0 text-accent-ink" />
            <span className="line-clamp-2">{improvement.title}</span>
          </div>
          <div className="mt-1 inline-flex items-center rounded-[5px] border border-line bg-panel px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-2">
            {OPPORTUNITY_LABELS[improvement.opportunity] ?? improvement.opportunity}
          </div>
          <div className="mt-1 font-mono text-[10px] text-ink-3 truncate" title={improvement.url}>
            {improvement.url.replace(/^https?:\/\/[^/]+/, "") || improvement.url}
          </div>
        </>
      ) : (
        <>
          <div className="text-xs text-ink leading-[1.35] line-clamp-2">{entry.keyword}</div>
          {label && (
            <div className="mt-1 inline-flex items-center rounded-[5px] border border-line bg-panel px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-2">
              {label}
            </div>
          )}
          {keyword && (
            <div className="mt-1 font-mono text-[10px] text-ink-3">
              Vol {num(keyword.volume)} · Diff {num(keyword.difficulty || null)}
            </div>
          )}
        </>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <StatusPill status={pill.status} label={pill.label} />
        {actions.openImprovement && improvementHref && (
          <Link href={improvementHref} className="text-[11px] text-accent-ink underline decoration-line underline-offset-[3px]">
            {state === "improved" ? "Review rewrite" : "Open"}
          </Link>
        )}
        {state === "writing" && (
          stalled ? (
            <span className="font-mono text-[10px] text-ink-3" title="Ten minutes with no result; nothing was charged for a draft that never arrived.">
              stopped responding
            </span>
          ) : (
            <span className="font-mono text-[10px] text-ink-3" role="status">
              <span className={inFlight?.phase === "drafting" ? "" : "text-accent-ink"}>research</span>
              {" → "}
              <span className={inFlight?.phase === "drafting" ? "text-accent-ink" : ""}>draft</span>
            </span>
          )
        )}
        {actions.openLive && article?.published_url && (
          <a href={article.published_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent-ink underline decoration-line underline-offset-[3px]">
            View live <Icons.externalLink size={10} />
          </a>
        )}
        {actions.openDraft && draftHref && !(actions.openLive && article?.published_url) && (
          <Link href={draftHref} className="text-[11px] text-accent-ink underline decoration-line underline-offset-[3px]">
            Open draft
          </Link>
        )}
      </div>
      {state === "frozen" && frozen && (
        <p className="m-0 mt-1 text-[10.5px] leading-snug text-ink-3" title={frozen}>
          {frozen}
        </p>
      )}
      {error && !dlg && <div className="mt-1 text-[11px] leading-snug text-err-ink">{error}</div>}

      {(keyword || drag || improvement) && state !== "writing" && (
        <div className="absolute -top-1 right-0 flex items-center gap-0.5 rounded-[7px] border border-line bg-bg p-0.5 shadow-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
          {actions.writeNow && (
            <button
              type="button"
              title={writeGate.ok ? "Write this article now; it lands in review" : writeGate.reason}
              disabled={!writeGate.ok}
              onClick={() => void startWriting()}
              className="h-6 inline-flex items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-ink-2 hover:bg-panel-2 disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Icons.sparkle size={12} />
              Write now
            </button>
          )}
          {keyword && actions.instructions && (
            <button
              type="button"
              title={hasInstructions ? "Instructions (set)" : "Instructions"}
              onClick={() => openDlg("instructions")}
              className={`${toolBtn} ${hasInstructions ? "text-warn-ink" : ""}`}
            >
              <Icons.lightbulb size={13} />
            </button>
          )}
          {keyword && actions.questions && (
            <button type="button" title="Questions" onClick={() => openDlg("questions")} className={`relative ${toolBtn}`}>
              <Icons.question size={13} />
              {unanswered > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-accent text-white font-mono text-[9px] leading-[14px] text-center">
                  {unanswered}
                </span>
              )}
            </button>
          )}
          {actions.move && (
            <button type="button" title="Move to another day" onClick={() => openDlg("move")} className={toolBtn}>
              <Icons.calendar size={13} />
            </button>
          )}
          {actions.remove && (
            <button
              type="button"
              title={improvement ? "Unschedule this improvement" : "Remove from plan"}
              onClick={() => { setRemoveScope("one"); openDlg("remove"); }}
              className={`${toolBtn} hover:bg-err-soft hover:text-err-ink`}
            >
              <Icons.trash size={13} />
            </button>
          )}
          {drag && (
            <button
              type="button"
              ref={drag.blocked ? undefined : drag.handleRef}
              {...(drag.blocked ? {} : drag.handleProps)}
              disabled={drag.blocked !== null}
              title={drag.blocked ?? "Drag to another day"}
              aria-label={drag.blocked ?? `Drag ${entry.keyword} to another day`}
              className={`${toolBtn} ${drag.blocked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing touch-none"}`}
            >
              <Icons.grip size={13} />
            </button>
          )}
        </div>
      )}

      {keyword && (
        <Dialog
          open={dlg === "instructions"}
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Article Instructions for "${keyword.term}"`}
          description="Anything the writer should know for this article in particular. It is passed along as written."
        >
          <form
            onSubmit={(e) => { e.preventDefault(); void act(() => saveKeywordBrief(keyword.id, { instructions, expectedLength })); }}
            className="space-y-3"
          >
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              placeholder="e.g. Lead with our own migration case; do not recommend competitors' hosted plans."
              className="w-full rounded-[7px] border border-line bg-bg px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-3"
            />
            <label className="block text-[12px] text-ink-3">
              Length
              <select
                value={expectedLength}
                onChange={(e) => setExpectedLength(e.target.value)}
                className="mt-1 w-full rounded-[7px] border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink"
              >
                {EXPECTED_LENGTHS.map((l) => <option key={l} value={l}>{LENGTH_LABELS[l]}</option>)}
              </select>
            </label>
            {error && <div className="text-[12px] text-err-ink">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setDlg(null)}>Cancel</Button>
              <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            </div>
          </form>
        </Dialog>
      )}

      {keyword && (
        <Dialog
          open={dlg === "questions"}
          onOpenChange={(o) => !o && setDlg(null)}
          title={`Questions for "${keyword.term}"`}
          description="Answer these questions to help personalize your article and match your style."
          className="max-w-[560px]"
        >
          {questions.length === 0 ? (
            <div className="text-[13px] text-ink-3 py-2">
              {generating ? "Writing questions for this keyword…" : "No questions could be generated for this keyword yet."}
              {!generating && (
                <div className="mt-3">
                  <Button size="sm" onClick={loadQuestions}>
                    Try again
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => { const merged = await saveKeywordAnswers(keyword.id, answers); setQuestions(merged); setAnswers({}); });
              }}
              className="space-y-3"
            >
              {questions.map((q) => (
                <label key={q.id} className="block">
                  <div className="text-[13px] text-ink mb-1">{q.question}</div>
                  <textarea
                    value={answers[q.id] ?? q.answer ?? ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                    rows={2}
                    placeholder="Your answer, in your own words. Leave blank if it does not apply."
                    className="w-full rounded-[7px] border border-line bg-bg px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-3"
                  />
                </label>
              ))}
              {error && <div className="text-[12px] text-err-ink">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setDlg(null)}>Cancel</Button>
                <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
              </div>
            </form>
          )}
        </Dialog>
      )}

      {actions.move && (
        <Dialog
          open={dlg === "move"}
          onOpenChange={(o) => !o && setDlg(null)}
          title="Move to another day"
          description={
            improvement
              ? `The rewrite of "${improvement.title}" is scheduled for ${entry.scheduled_date.slice(0, 10)}; it runs on the first improvement day on or after the date you pick.`
              : `"${entry.keyword}" is planned for ${entry.scheduled_date.slice(0, 10)}.`
          }
        >
          <form onSubmit={(e) => { e.preventDefault(); void act(() => move(date)); }} className="space-y-3">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-[7px] border border-line bg-bg px-3 py-2 text-[13px] text-ink"
            />
            {error && <div className="text-[12px] text-err-ink">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setDlg(null)}>Cancel</Button>
              <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "Moving…" : "Move"}</Button>
            </div>
          </form>
        </Dialog>
      )}

      {actions.remove && (
        <Dialog
          open={dlg === "remove"}
          onOpenChange={(o) => !o && setDlg(null)}
          title={improvement ? "Unschedule this improvement" : state === "frozen" ? "Remove inactive keyword?" : "Remove from plan"}
        >
          {improvement ? (
            <p className="text-[13px] text-ink-2">
              The rewrite of &ldquo;{improvement.title}&rdquo; comes off the calendar. The page stays listed under
              Improvements, where it can be scheduled again; nothing on your site changes.
            </p>
          ) : state === "frozen" && frozenCount > 1 ? (
            <fieldset className="space-y-2 text-[13px] text-ink-2">
              <legend className="mb-2">
                &ldquo;{entry.keyword}&rdquo; is inactive under the current plan. Removed keywords come off the calendar and
                stay tracked; the planner will not put them back.
              </legend>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="remove-scope" className="mt-0.5" checked={removeScope === "one"} onChange={() => setRemoveScope("one")} />
                <span>Remove only &ldquo;{entry.keyword}&rdquo;</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="remove-scope" className="mt-0.5" checked={removeScope === "all"} onChange={() => setRemoveScope("all")} />
                <span>Remove all {frozenCount} inactive keywords</span>
              </label>
            </fieldset>
          ) : (
            <p className="text-[13px] text-ink-2">
              Are you sure you want to remove the keyword &ldquo;{entry.keyword}&rdquo;? It comes off the calendar and the
              planner will not put it back; the keyword itself stays tracked.
            </p>
          )}
          {error && <div className="mt-2 text-[12px] text-err-ink">{error}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDlg(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={pending} onClick={() => void act(remove)}>
              {pending ? "Removing…" : improvement ? "Unschedule" : state === "frozen" && removeScope === "all" ? `Remove ${frozenCount} inactive` : "Remove"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
