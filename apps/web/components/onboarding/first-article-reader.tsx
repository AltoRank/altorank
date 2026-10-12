"use client";

// ---------------------------------------------------------------------------
// The first article in full on the gate, as it is written (PRETRIAL_FULL_ARTICLE)
// ---------------------------------------------------------------------------
//
// Rendered only when the server says the switch is on and the person is the
// owner (app/(setup)/onboarding/page.tsx). The text comes from the gate's
// one poller (./use-first-article-live.ts), already rebuilt from an
// allowlist on the server (lib/onboarding/readable-html.ts); this only
// decides how much of it is on screen (lib/onboarding/stream-reveal.ts),
// cutting between whole tags of that html, so it never makes markup of its
// own beyond closing what it opened and the caret below.
//
// - typed at a reading pace, a character at a time, a little quicker when a
//   backlog builds and quicker again once the body is saved, never in
//   blocks cut mid-word (lib/onboarding/stream-reveal.ts);
// - one element per top-level block, keyed by position, so text already
//   shown is never re-rendered; a new block rises in;
// - the page never scrolls itself. It used to follow the caret down, and on
//   2026-10-12 it scrolled a reader 1,000px while they were reading (UX
//   audit #10). When the caret is below the screen, a "Jump to the latest"
//   pill offers the way down instead, once, on a click;
// - before the first word, the outline it is being written to stands in for
//   the text, so the reader is never an empty box.
//
// Less motion asked for: the text appears as it arrives, without typing or
// rising. Nothing here edits, approves or publishes. Its links open in a new
// tab and sit outside the tab order (lib/onboarding/readable-html.ts).

import { memo, useEffect, useRef, useState } from "react";
import { Icons } from "@/components/ui";
import { revealPrefix, revealStep, splitBlocks, startAt, visibleLength, withCaret, type RevealState } from "@/lib/onboarding/stream-reveal";
import { useReducedMotion } from "./use-first-article-live";

/** One top-level block of the server-cleaned html (see the header). */
const Block = memo(function Block({ html, rise }: { html: string; rise: boolean }) {
  return <div className={rise ? "rise-in" : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
});

export function FirstArticleText({
  html,
  done,
  outline = [],
  waiting,
  onRevealing,
}: {
  html: string;
  done: boolean;
  /**
   * Told whether text is still appearing: being written, or written and
   * still being typed out. The gate keeps its "being written" heading and
   * its trial bar up until it is not (review, 2026-10-12: the last ~4,000
   * characters typed for 14s under "written", with no button on screen).
   */
  onRevealing?: (revealing: boolean) => void;
  /** The headings it is written to: shown, muted, until the first words land. */
  outline?: string[];
  /** What is happening before the first word, for the placeholder. */
  waiting: string;
}) {
  const available = visibleLength(html);
  const reduced = useReducedMotion();
  // A body already written when the page opened is shown whole, at once:
  // there is nothing to watch being typed. One that lands while the page is
  // open keeps being typed to its end.
  const [reveal, setReveal] = useState<RevealState>(() => startAt(available, done));
  // Less motion asked for: everything that has arrived, at once.
  const shown = reduced ? available : Math.min(reveal.shown, available);
  // Blocks already there on the first paint (a reload) do not rise; every
  // block after them does, once, when it first appears. Fixed per index, so
  // a block's class never changes under it and never replays the rise.
  const [settledBlocks] = useState(() => splitBlocks(revealPrefix(html, startAt(available, done).shown)).length);
  const container = useRef<HTMLDivElement | null>(null);
  const [caretBelow, setCaretBelow] = useState(false);

  // The typing loop: one frame at a time toward what has arrived.
  const typing = !reduced && shown < available;
  // Whether anything has been typed yet: a page opened half-way through a
  // body starts where the text already is, but for its tail (`startAt`).
  const begun = useRef(reveal.shown > 0);
  useEffect(() => {
    if (!typing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      const first = !begun.current;
      begun.current = true;
      setReveal((r) => (first && r.shown === 0 ? revealStep(startAt(available, false), available, dt, done) : revealStep(r, available, dt, done)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [typing, available, done]);

  // Still appearing: being written, or written and still being typed out.
  const writing = !done || shown < available;
  const revealed = shown >= available ? html : revealPrefix(html, shown);
  const blocks = splitBlocks(revealed);

  // Whether the caret is below the screen, read after every scroll and every
  // frame of text: the pill is offered then and only then.
  useEffect(() => {
    if (!writing) return;
    const check = () => {
      const caret = container.current?.querySelector(".stream-caret");
      if (!caret) return;
      setCaretBelow(caret.getBoundingClientRect().top > window.innerHeight - 24);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [writing, blocks.length, shown]);

  // Nothing in hand yet counts as not revealing: the gate decides that case
  // from the html itself.
  const revealing = Boolean(html) && writing;
  useEffect(() => {
    onRevealing?.(revealing);
  }, [revealing, onRevealing]);
  useEffect(() => () => onRevealing?.(false), [onRevealing]);

  if (!html) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <p className="m-0 flex items-center gap-2 text-[13px] text-ink-2">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          {waiting}
        </p>
        {outline.length > 0 && (
          <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="The outline it is being written to">
            {outline.map((heading, i) => (
              <li key={`${i}-${heading}`} className="flex flex-col gap-1.5">
                <span className="text-[15px] font-semibold leading-snug text-ink-3">{heading}</span>
                {i === 0 && (
                  <>
                    <span className="h-2.5 w-full rounded-full bg-panel-2 motion-safe:animate-pulse" aria-hidden />
                    <span className="h-2.5 w-4/5 rounded-full bg-panel-2 motion-safe:animate-pulse" aria-hidden />
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  return (
    <>
      <div ref={container} className="article-text" aria-busy={writing}>
        {blocks.map((block, i) => (
          <Block key={i} html={writing && i === blocks.length - 1 ? withCaret(block) : block} rise={i >= settledBlocks} />
        ))}
        {writing && blocks.length === 0 && <span className="stream-caret" aria-hidden="true" />}
      </div>
      {writing && caretBelow && (
        <button
          type="button"
          onClick={() => {
            const caret = container.current?.querySelector(".stream-caret");
            caret?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
          }}
          className="fixed bottom-24 left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 py-2 text-[12.5px] text-ink shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="inline-flex rotate-90">
            <Icons.arrow size={12} />
          </span>
          Jump to the latest
        </button>
      )}
    </>
  );
}
