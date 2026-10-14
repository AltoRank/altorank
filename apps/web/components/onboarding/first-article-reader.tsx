"use client";

// ---------------------------------------------------------------------------
// The first article in full on the gate, read-only (PRETRIAL_FULL_ARTICLE)
// ---------------------------------------------------------------------------
//
// Rendered only when the server says the switch is on and the person is the
// owner (app/(setup)/onboarding/page.tsx). It asks /api/onboard/first-article
// for the text every few seconds while the body is being written, so it
// streams in, and stops once the saved article comes back. Nothing here
// edits, approves or publishes: those open with the trial. The text arrives
// already cleaned on the server (lib/onboarding/first-article-body.ts).

import { useEffect, useState } from "react";

const POLL_MS = 2_500;
/** Stop asking after this long without a finished body; the gate still stands. */
const GIVE_UP_MS = 10 * 60_000;

export function FirstArticleReader({ workspaceId, title }: { workspaceId: string; title: string }) {
  const [html, setHtml] = useState<string>("");
  const [done, setDone] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    async function poll() {
      try {
        const res = await fetch(`/api/onboard/first-article?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        if (stopped) return;
        if (res.status === 404 || res.status === 401) {
          setUnavailable(true);
          return;
        }
        if (res.ok) {
          const body = (await res.json()) as { html?: string; done?: boolean };
          if (stopped) return;
          if (typeof body.html === "string") setHtml(body.html);
          if (body.done) {
            setDone(true);
            return;
          }
        }
      } catch {
        // A missed poll is the next one's.
      }
      if (!stopped && Date.now() - started < GIVE_UP_MS) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [workspaceId]);

  if (unavailable) return null;
  return (
    <section aria-label="Your first article, in full" className="rounded-[10px] border border-line bg-bg p-5" data-testid="first-article-reader">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Read it in full</span>
        <span className="text-[11.5px] text-ink-3">{done ? "Written" : "Being written…"}</span>
      </div>
      <h2 className="m-0 mb-3 text-[18px] font-semibold leading-snug text-ink">{title}</h2>
      {html ? (
        <div className="prose prose-sm max-w-none text-ink [&_a]:text-accent [&_h2]:mt-5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-[14px] [&_h3]:font-semibold [&_p]:my-2 [&_p]:text-[13.5px] [&_p]:leading-[1.65] [&_li]:text-[13.5px]" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="m-0 text-[12.5px] text-ink-3">The text appears here as it is written.</p>
      )}
      <p className="m-0 mt-4 text-[12px] text-ink-2">Read-only. Editing, approving and publishing open with your trial.</p>
    </section>
  );
}
