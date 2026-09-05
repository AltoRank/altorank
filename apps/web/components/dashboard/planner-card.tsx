"use client";

// ---------------------------------------------------------------------------
// One planned keyword on the calendar
// ---------------------------------------------------------------------------
//
// The square used to show a term and a status. It now shows the keyword as an
// object - shape, volume, difficulty - and lets the person do the four things
// a plan is for: tell the writer something, answer its questions, move the day,
// take it off. Actions live in a hover row so the grid stays a calendar rather
// than a toolbar.
//
// "—" wherever a number is unknown. Volume 0 from a provider is a measurement;
// a null difficulty is not, and rendering it as 0 is the green-zero bug again.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Button, Dialog, Icons, StatusPill } from "@/components/ui";
import type { CalendarEntry } from "@/lib/types";
import type { PlannerKeyword } from "@/lib/queries/keywords";
import { taxonomyLabel, EXPECTED_LENGTHS, LENGTH_LABELS } from "@/lib/keywords/taxonomy";
import { parseStoredQuestions, unansweredCount, type QualityQuestion } from "@/lib/keywords/questions";
import {
  ensureKeywordQuestions,
  removePlannedEntry,
  reschedulePlannedEntry,
  saveKeywordAnswers,
  saveKeywordBrief,
} from "@/app/actions/plan";

const stLabel: Record<string, string> = { done: "Published", run: "Drafting", scheduled: "Scheduled", queue: "Queued" };

function num(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : "—";
}

type Dlg = null | "instructions" | "questions" | "move" | "remove";

export function PlannerCard({
  entry,
  keyword,
  workspace,
}: {
  entry: CalendarEntry;
  keyword: PlannerKeyword | null;
  workspace: { initials: string; color: string; domain: string | null } | null;
}) {
  const router = useRouter();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [instructions, setInstructions] = useState(keyword?.instructions ?? "");
  const [expectedLength, setExpectedLength] = useState(keyword?.expected_length ?? "auto");
  const [questions, setQuestions] = useState<QualityQuestion[]>(parseStoredQuestions(keyword?.quality_questions));
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [date, setDate] = useState(entry.scheduled_date.slice(0, 10));

  // Only a calendar row with no article can be moved or removed. Everything
  // with a keyword row can be briefed, written or not: the brief is the
  // keyword's, and it applies to the next draft too.
  const movable = entry.planned && !entry.article_id;
  const label = taxonomyLabel(keyword?.article_subtype);
  const unanswered = unansweredCount(questions);
  const hasInstructions = Boolean(keyword?.instructions?.trim());

  // Lazily generate when the questions dialog opens on an empty row.
  useEffect(() => {
    if (dlg !== "questions" || !keyword || questions.length > 0 || generating) return;
    let cancelled = false;
    setGenerating(true);
    ensureKeywordQuestions(keyword.id)
      .then((qs) => { if (!cancelled) setQuestions(qs); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not generate questions."); })
      .finally(() => { if (!cancelled) setGenerating(false); });
    return () => { cancelled = true; };
  }, [dlg, keyword, questions.length, generating]);

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

  const openDlg = (d: Dlg) => { setError(null); setDlg(d); };

  return (
    <div className="group text-xs relative">
      {workspace && (
        <div className="flex items-center gap-1.5 mb-1.5">
          <Avatar initials={workspace.initials} color={workspace.color} size="sm" className="w-4 h-4 text-[8px] rounded" />
          <span className="font-mono text-[10px] text-ink-3 truncate">{workspace.domain}</span>
        </div>
      )}
      <div className="text-xs text-ink leading-[1.35] line-clamp-2">{entry.keyword}</div>
      {label && (
        <div className="mt-1 inline-flex items-center rounded-[5px] border border-line bg-panel px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-2">
          {label}
        </div>
      )}
      {keyword && (
        <div className="mt-1 font-mono text-[10px] text-ink-3">
          Vol {num(keyword.volume)} · Diff {num(keyword.difficulty)}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <StatusPill status={entry.status} label={stLabel[entry.status]} />
      </div>

      {keyword && (
        <div className="absolute -top-1 right-0 hidden group-hover:flex items-center gap-0.5 rounded-[7px] border border-line bg-bg p-0.5 shadow-sm">
          <button
            type="button"
            title={hasInstructions ? "Instructions (set)" : "Instructions"}
            onClick={() => openDlg("instructions")}
            className={`w-6 h-6 inline-grid place-items-center rounded-[5px] hover:bg-panel-2 ${hasInstructions ? "text-warn-ink" : "text-ink-3"}`}
          >
            <Icons.lightbulb size={13} />
          </button>
          <button
            type="button"
            title="Questions"
            onClick={() => openDlg("questions")}
            className="relative w-6 h-6 inline-grid place-items-center rounded-[5px] text-ink-3 hover:bg-panel-2"
          >
            <Icons.question size={13} />
            {unanswered > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-accent text-white font-mono text-[9px] leading-[14px] text-center">
                {unanswered}
              </span>
            )}
          </button>
          {movable && (
            <>
              <button type="button" title="Move to another day" onClick={() => openDlg("move")} className="w-6 h-6 inline-grid place-items-center rounded-[5px] text-ink-3 hover:bg-panel-2">
                <Icons.calendar size={13} />
              </button>
              <button type="button" title="Remove from plan" onClick={() => openDlg("remove")} className="w-6 h-6 inline-grid place-items-center rounded-[5px] text-ink-3 hover:bg-err-soft hover:text-err-ink">
                <Icons.trash size={13} />
              </button>
            </>
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
                  <Button size="sm" onClick={() => { setError(null); setQuestions([]); setGenerating(false); setDlg(null); setTimeout(() => setDlg("questions"), 0); }}>
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

      {movable && (
        <Dialog open={dlg === "move"} onOpenChange={(o) => !o && setDlg(null)} title="Move to another day" description={`"${entry.keyword}" is planned for ${entry.scheduled_date.slice(0, 10)}.`}>
          <form onSubmit={(e) => { e.preventDefault(); void act(() => reschedulePlannedEntry(entry.id, date)); }} className="space-y-3">
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

      {movable && (
        <Dialog open={dlg === "remove"} onOpenChange={(o) => !o && setDlg(null)} title="Remove from plan">
          <p className="text-[13px] text-ink-2">
            Are you sure you want to remove the keyword &ldquo;{entry.keyword}&rdquo;? It comes off the calendar and the
            planner will not put it back; the keyword itself stays tracked.
          </p>
          {error && <div className="mt-2 text-[12px] text-err-ink">{error}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDlg(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={pending} onClick={() => void act(() => removePlannedEntry(entry.id))}>
              {pending ? "Removing…" : "Remove"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
