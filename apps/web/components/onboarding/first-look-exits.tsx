"use client";

// ---------------------------------------------------------------------------
// The soft exits on the first look: "Email me when it's ready", "Email me this article"
// ---------------------------------------------------------------------------
//
// Small, quiet controls beside the screen's one primary action, never
// competing with it. Each says what actually happened when pressed - sent,
// already sent, or why not - from the server's answer
// (app/actions/first-look-exits.ts), which checks the owner, the trial, the
// email preferences and the daily cap.

import { useState, useTransition } from "react";
import { emailFirstArticle, emailWhenReady, type ExitAnswer } from "@/app/actions/first-look-exits";

function answerLine(answer: ExitAnswer, sentLine: (email: string) => string, alreadyLine: (email: string) => string): string {
  if (!answer.ok) return answer.message;
  return answer.already ? alreadyLine(answer.email) : sentLine(answer.email);
}

function ExitButton({
  label,
  run,
  sentLine,
  alreadyLine = sentLine,
  className = "",
}: {
  label: string;
  run: () => Promise<ExitAnswer>;
  sentLine: (email: string) => string;
  alreadyLine?: (email: string) => string;
  className?: string;
}) {
  const [said, setSaid] = useState<{ line: string; ok: boolean } | null>(null);
  // A request that never reached an answer (network, server error), or an
  // answer that says to ask again, keeps the button beside its line: the line
  // says "try again", so there has to be something to press.
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (said) {
    return (
      <p role="status" className={`m-0 text-[12.5px] leading-[1.5] ${said.ok ? "text-ink-2" : "text-ink-3"} ${className}`}>
        {said.line}
      </p>
    );
  }
  const button = (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          setFailed(null);
          try {
            const answer = await run();
            if (!answer.ok && answer.retry) setFailed(answer.message);
            else setSaid({ line: answerLine(answer, sentLine, alreadyLine), ok: answer.ok });
          } catch {
            setFailed("That did not go through. Try again in a minute.");
          }
        })
      }
      className={`text-[12.5px] text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink disabled:opacity-50 ${failed ? "" : className}`}
    >
      {pending ? "One moment…" : label}
    </button>
  );
  if (!failed) return button;
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-2 ${className}`}>
      {button}
      <span role="status" className="text-[12.5px] leading-[1.5] text-ink-3">
        {failed}
      </span>
    </span>
  );
}

/** Past the estimate: the written-article email is coming, if this owner gets draft emails. */
export function EmailWhenReady({ workspaceId, className }: { workspaceId: string; className?: string }) {
  return (
    <ExitButton
      label="Email me when it's ready"
      run={() => emailWhenReady(workspaceId)}
      sentLine={(email) => `We will email ${email} when your first article is written. You can close this page.`}
      className={className}
    />
  );
}

/** Under the trial button: a link back to the article, by email, once. */
export function EmailMeArticle({ workspaceId, className }: { workspaceId: string; className?: string }) {
  return (
    <ExitButton
      label="Not ready yet? Email me this article"
      run={() => emailFirstArticle(workspaceId)}
      sentLine={(email) => `Sent to ${email}: a link back to this article, which stays here.`}
      alreadyLine={(email) => `We already sent the link to ${email}. The article stays here.`}
      className={className}
    />
  );
}
