"use client";

// ---------------------------------------------------------------------------
// "What stopped you?", under the trial offer
// ---------------------------------------------------------------------------
//
// One quiet line, folded, below everything the offer says: it must never
// compete with the trial button, and a person who was about to press it is
// not shown a list of reasons not to. Opened, it is one pick; "Something
// else" takes a few words. The answer is kept once per site
// (lib/onboarding/gate-answer-store.ts), so pressing twice changes nothing.

import { useState, useTransition } from "react";
import { answerGate } from "@/app/actions/gate-answer";
import { GATE_ANSWER_NOTE_MAX, GATE_REASON_LABELS } from "@/lib/onboarding/gate-answer";
import { GATE_REASONS, type GateReason } from "@/lib/onboarding/step-props";

export function GateQuestion({ workspaceId, className = "" }: { workspaceId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  const send = (reason: GateReason, text?: string) =>
    start(async () => {
      setFailed(false);
      try {
        const out = await answerGate(workspaceId, reason, text);
        if (out.ok) setDone(true);
        else setFailed(true);
      } catch {
        setFailed(true);
      }
    });

  if (done) {
    return (
      <p role="status" className={`m-0 text-[12.5px] leading-[1.5] text-ink-2 ${className}`}>
        Thank you. That is what we needed to know.
      </p>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-[12.5px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink-2 ${className}`}
      >
        Not starting the trial? Tell us what stopped you
      </button>
    );
  }
  return (
    <div className={`rounded-[10px] border border-line bg-panel p-3 ${className}`}>
      <p className="m-0 mb-2 text-[12.5px] font-medium text-ink">What stopped you?</p>
      <div role="group" aria-label="What stopped you" className="flex flex-col gap-1.5">
        {GATE_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            disabled={pending}
            aria-pressed={reason === "other" && other}
            onClick={() => (reason === "other" ? setOther(true) : send(reason))}
            className="rounded-[7px] border border-line bg-bg px-3 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:border-accent hover:text-ink disabled:opacity-50"
          >
            {GATE_REASON_LABELS[reason]}
          </button>
        ))}
      </div>
      {other && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            autoFocus
            rows={2}
            maxLength={GATE_ANSWER_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="A few words is plenty."
            aria-label="What stopped you, in your words"
            className="w-full rounded-[7px] border border-line bg-bg px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => send("other", note)}
            className="self-start rounded-[7px] border border-line bg-bg px-3 py-1.5 text-[12.5px] font-medium text-ink hover:border-accent disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      )}
      {failed && (
        <p role="status" className="m-0 mt-2 text-[12px] text-ink-3">
          That did not go through. Try again in a minute.
        </p>
      )}
    </div>
  );
}
