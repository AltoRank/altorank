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
// - typed at the writer's pace with a catch-up, a caret at the end while it
//   is being written, never in two-second blocks cut mid-word;
// - one element per top-level block, keyed by position, so text already
//   shown is never re-rendered; a new block rises in;
// - the page follows the caret only while the reader is watching it (the
//   caret is on screen after the last scroll the follow did not make);
//   scrolled away by any means, a "Jump to the latest" pill brings them
//   back instead of the page pulling them down;
// - before the first word, the outline it is being written to stands in for
//   the text, so the reader is never an empty box.
//
// Less motion asked for: the text appears as it arrives, without typing,
// rising or following. Nothing here edits, approves or publishes.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icons } from "@/components/ui";
import { nextShown, revealPrefix, splitBlocks, visibleLength, withCaret } from "@/lib/onboarding/stream-reveal";
import { useReducedMotion } from "./use-first-article-live";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Room kept under the caret when the page follows it. */
const FOLLOW_MARGIN = 120;

/** One top-level block of the server-cleaned html (see the header). */
const Block = memo(function Block({ html, rise }: { html: string; rise: boolean }) {
  return <div className={rise ? "rise-in" : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
});

export function FirstArticleText({
  html,
  done,
  arrivalCps = 0,
  outline = [],
  waiting,
}: {
  html: string;
  done: boolean;
  arrivalCps?: number;
  /** The headings it is written to: shown, muted, until the first words land. */
  outline?: string[];
  /** What is happening before the first word, for the placeholder. */
  waiting: string;
}) {
  const available = visibleLength(html);
  const reduced = useReducedMotion();
  // A body already written when the page opened is shown whole, at once:
  // there is nothing to watch being typed.
  const [typed, setShown] = useState(() => (done ? available : 0));
  // Written, or less motion asked for: everything that has arrived, at once.
  const shown = done || reduced ? available : Math.min(typed, available);
  // Blocks already there on the first paint (a reload) do not rise; every
  // block after them does, once, when it first appears. Fixed per index, so
  // a block's class never changes under it and never replays the rise.
  const [settledBlocks] = useState(() => (done ? splitBlocks(html).length : 0));
  const container = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [caretAway, setCaretAway] = useState(false);
  // Where the page's own follow last sent the window, so the scroll event it
  // causes is not read as the person's; and, after "Jump to the latest", how
  // long to let the smooth scroll run before reading positions again.
  const ownScrollTo = useRef<number | null>(null);
  const settleUntil = useRef(0);

  // The typing loop: one frame at a time toward what has arrived.
  useEffect(() => {
    if (reduced || done) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      setShown((s) => {
        const next = nextShown(s, available, dt, arrivalCps);
        if (next < available) raf = requestAnimationFrame(tick);
        return next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [available, done, reduced, arrivalCps]);

  const writing = !done;
  const revealed = shown >= available ? html : revealPrefix(html, shown);
  const blocks = splitBlocks(revealed);

  // Whether the page follows is decided by where the caret is, after every
  // scroll the follow itself did not cause - a wheel, a touch, a key, Tab
  // onto a button below, a dragged scrollbar, a resize, an anchor. It used to
  // change only on wheel, touch and a list of keys, so anything else left it
  // "following" with the caret above the screen, and the pill, shown only
  // when not following, never came (review, 2026-10-12).
  useEffect(() => {
    if (!writing) return;
    const check = () => {
      if (performance.now() < settleUntil.current) return;
      const own = ownScrollTo.current;
      if (own !== null && Math.abs(window.scrollY - own) <= 2) {
        ownScrollTo.current = null;
        return;
      }
      ownScrollTo.current = null;
      const caret = container.current?.querySelector(".stream-caret");
      if (!caret) return;
      const r = caret.getBoundingClientRect();
      const inView = r.top >= 0 && r.bottom <= window.innerHeight;
      setCaretAway(!inView);
      setFollowing(inView);
    };
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [writing]);

  // Follow the caret, gently: only while following, only by what it moved.
  useIsoLayoutEffect(() => {
    if (!writing) return;
    const caret = container.current?.querySelector(".stream-caret");
    if (!caret) return;
    const r = caret.getBoundingClientRect();
    const limit = window.innerHeight - FOLLOW_MARGIN;
    if (following && !reduced && r.bottom > limit && r.top >= 0 && r.top < window.innerHeight + 200) {
      const by = r.bottom - limit;
      ownScrollTo.current = window.scrollY + by;
      window.scrollBy(0, by);
      return;
    }
    const away = r.top < 0 || r.bottom > window.innerHeight;
    if (away !== caretAway) setCaretAway(away);
    // Off screen where the follow will not go (above, far below, or less
    // motion asked for): the person is somewhere else, so the pill offers
    // the way back instead.
    if (away && following && performance.now() >= settleUntil.current) setFollowing(false);
  });

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
      {writing && caretAway && !following && (
        <button
          type="button"
          onClick={() => {
            const caret = container.current?.querySelector(".stream-caret");
            settleUntil.current = performance.now() + (reduced ? 50 : 900);
            caret?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
            setFollowing(true);
            setCaretAway(false);
          }}
          className="fixed bottom-20 left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 py-2 text-[12.5px] text-ink shadow-md"
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
