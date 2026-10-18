"use client";

// ---------------------------------------------------------------------------
// The first article, before the trial: what it is, and it being written
// ---------------------------------------------------------------------------
//
// One card for both places the trial is asked for - the end of the setup run
// and every later visit to /onboarding - so the two cannot drift apart. It
// leads the gate: the article first, the ask under it (recorded 2026-10-12:
// with the ask and a ten-button survey above it, only the article's title
// was above the fold, and on a phone none of it).
//
// While the body is written behind it, the card shows the work, never the
// text unless the owner may read it:
//
// - PRETRIAL_FULL_ARTICLE off: the outline, each section ticked as the
//   writer finishes it, with the words so far (counts only, from
//   /api/onboard/first-article/progress);
// - on, for the owner: the text itself replaces the outline as it is
//   written (./first-article-reader.tsx), so the headings are not on the
//   page twice.
//
// Nothing here says "written" before the body is saved; the length is the
// target until then and the real count after; "Sources" is not printed as a
// zero. There is no link: there is nowhere to read the article before the
// trial but here. Every prop is built on the server (lib/onboarding/
// first-article.ts) and carries no text beyond the headings.

import { Icons } from "@/components/ui";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";
import type { Opportunity } from "@/lib/keyword-research/opportunity";
import { bodyFraction, clock, estimateLine, firstLookFraction, runningLong, type BodyStage } from "@/lib/onboarding/setup-progress";
import { EmailWhenReady } from "./first-look-exits";
import { ProgressBar, useNow } from "./progress-bar";
import { FirstArticleText } from "./first-article-reader";
import type { FirstArticleLive } from "./use-first-article-live";

const n = (x: number) => x.toLocaleString("en-US");

/** The one clock is shown for this long after the run started; past it, only "taking longer". */
const CLOCK_SHOWN_FOR_S = 30 * 60;

/** Below this many, the source count is not shown: one or two read as thin research. */
export const MIN_SOURCES_SHOWN = 3;

/** What the run itself knows about the draft, for the moment before the card is read. */
export type PendingFirstArticle = {
  title: string;
  keyword: string;
  wordCount: number;
  /** Outlined, body still being written: the length is a target. */
  outlined?: boolean;
};

function Fact({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2 sm:col-span-1" : ""}`}>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="m-0 break-words text-[12.5px] leading-snug text-ink">{children}</dd>
    </div>
  );
}

/**
 * The stage in the person's words. Only this goes in the live region: it
 * changes a handful of times in two minutes. The word count beside it
 * changes on every answer and is not read out (`wordsLine`); a screen reader
 * re-read the whole line every second or two while the body was written
 * (review, 2026-10-12).
 */
export function stageLine(stage: BodyStage | null, written: number, total: number): string {
  if (stage === "writing") return total > 0 ? `Writing section ${Math.min(total, written + 1)} of ${total}` : "Writing";
  if (stage === "finishing") return "Checking its facts and adding links";
  return "Planning each section from the pages that rank for it";
}

/** The words so far, beside the stage; empty before the first. */
export function wordsLine(stage: BodyStage | null, words: number): string {
  if (words <= 0) return "";
  return stage === "finishing" ? `${n(words)} words` : `${n(words)} words so far`;
}

/**
 * Who the article is for, as the planner wrote it. Only the audience: it was
 * joined to the buying job with a comma, and the job is a capitalised
 * imperative, so the line read "…decor ideas, Source handmade …" on every
 * gate (review, 2026-10-12).
 */
export function writtenFor(brief: Pick<Opportunity, "audience"> | null | undefined): string | null {
  const audience = brief?.audience?.trim().replace(/\.$/, "");
  return audience ? audience : null;
}

/**
 * Whether a run that is taking long offers "you can leave this page": only
 * while nothing is on screen to read. With text there, the article is
 * finishing in front of the owner (review, 2026-10-12).
 */
export function offersLeave(long: boolean, textOnScreen: boolean): boolean {
  return long && !textOnScreen;
}

export function FirstArticleCardView({
  article,
  pending = null,
  brief,
  live,
  readable = false,
  startedAt = null,
  workspaceId,
  settling = false,
  onRevealing,
}: {
  article: FirstArticleCard | null;
  /** Shown while the page has not yet read the card for a draft the run just wrote. */
  pending?: PendingFirstArticle | null;
  /** The planner's brief for its topic: who it is for and why. */
  brief?: Opportunity | null;
  /** The body as it is being written (./use-first-article-live.ts); null when there is nothing to watch. */
  live?: FirstArticleLive | null;
  /** The full text is shown in the card (PRETRIAL_FULL_ARTICLE, the owner). */
  readable?: boolean;
  /**
   * When the run started, on this browser's clock: the one clock from the
   * click to the written article continues here. Null when unknown, and the
   * bar then counts the body alone.
   */
  startedAt?: number | null;
  /** For "Email me when it's ready", offered once it runs long. */
  workspaceId?: string;
  /** Saved, but its text is not all on screen yet: the badge waits for it. */
  settling?: boolean;
  /** Passed to the reader: whether text is still appearing. */
  onRevealing?: (revealing: boolean) => void;
}) {
  const outlinedOnPage = article ? article.state === "outlined" : pending?.outlined === true;
  // Written once the server says so, whichever read says it first.
  const written = !outlinedOnPage || live?.done === true;
  const writing = !written && !live?.refused;
  const now = useNow(500, writing);
  if (!article && !pending) return null;

  const title = article?.title || pending?.title || article?.keyword || pending?.keyword || "Untitled";
  const keyword = article?.keyword ?? pending?.keyword ?? "";
  const target = outlinedOnPage ? article?.wordCount ?? pending?.wordCount ?? 0 : 0;
  // The saved count once the body is in: the card read by the page, or the
  // poller's answer before the page has read it again.
  const finalWords = outlinedOnPage ? (live?.done ? live.words : 0) : article?.wordCount ?? pending?.wordCount ?? 0;
  const outline = article?.outline ?? [];
  // The site's own closing (lib/onboarding/first-article.ts) is counted for
  // the writer's progress but not listed: it is not a section of the article.
  const shownOutline = article?.closing && outline[outline.length - 1] === article.closing ? outline.slice(0, -1) : outline;
  const done = new Set(written ? outline.map((_, i) => i) : live?.sectionsDone ?? []);
  const stage = live?.stage ?? null;
  const stageS = live?.stageSince && now ? (now - live.stageSince) / 1000 : 0;
  const elapsed = startedAt !== null && now ? Math.max(0, (now - startedAt) / 1000) : null;
  const long = elapsed !== null && runningLong(elapsed, true);
  const purpose = writtenFor(brief);
  const showText = readable && live && !live.refused;
  const liveWords = writing ? live?.words ?? 0 : 0;
  const badgeWritten = written && !settling;
  // Running long, and nothing to read yet: only then is the owner told they
  // may leave. With the text on screen the article is finishing in front of
  // them, and "you can leave this page" invited them away at the moment the
  // trial is asked for (review, 2026-10-12); the clock's label still says it
  // is taking longer.
  const offerLeave = offersLeave(long, Boolean(showText && live?.html));

  return (
    <section aria-label="Your first article" className="rise-in rounded-[10px] border border-line bg-panel p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Your first article</span>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${badgeWritten ? "bg-ok-soft text-ok-ink" : "border border-line text-ink-2"}`}>
          {badgeWritten ? <Icons.check size={10} /> : <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />}
          {badgeWritten ? "Written" : "Being written"}
        </span>
      </div>
      <h2 className="m-0 text-[19px] font-semibold leading-snug text-ink">{title}</h2>
      {purpose && (
        <p className="m-0 mt-1.5 text-[13px] leading-[1.55] text-ink-2">
          <span className="text-ink-3">Written for: </span>
          {purpose}
        </p>
      )}
      {/* No verdict labels here. Before the trial this card is the paywall,
          and "Early reader … not yet shopping", "Lower confidence" and
          "Unmeasured" in warning orange argued against buying the thing
          the page was selling (UX audit 2026-10-12, #8). The calendar
          keeps the planner's own words once the trial starts. */}
      <dl className="m-0 mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <Fact label="Target search" wide>{keyword || "—"}</Fact>
        {/* Not a date: before the trial nothing publishes, and "Scheduled
            for" today read as a promise the gate then broke, and later as a
            day in the past (UX audit 2026-10-12). */}
        <Fact label="Publishing">Ready when you approve it</Fact>
        {/* One word figure on the card: the target only until the writer's
            own count is in, then that count - "About 800 words" beside
            "1,076 words so far" read as a contradiction (review,
            2026-10-12). */}
        <Fact label="Length">
          {finalWords > 0
            ? `${n(finalWords)} words`
            : liveWords > 0
              ? `${n(liveWords)} words so far`
              : target > 0
                ? `About ${n(target)} words`
                : "—"}
        </Fact>
        {/* Counted from the article's own links once written; while it is
            being written, the pages its outline plans to cite. A zero is
            not printed: it read as "no research" (recorded 2026-10-12), and
            neither is one or two, which read as thin. */}
        {article && article.sources >= MIN_SOURCES_SHOWN && <Fact label={written && article.state === "written" ? "Sources cited" : "Sources planned"}>{n(article.sources)}</Fact>}
      </dl>

      {writing && (
        <div className="mt-4 flex flex-col gap-1.5">
          {/* The same bar and clock as the loading screen, carried on: the
              setup is its first part, the body the rest (UX audit 2026-10-12,
              #7). Without the run's start, the body's own share. */}
          <ProgressBar
            fraction={startedAt !== null ? firstLookFraction([], 0, { stage, stageElapsedS: stageS, done: false }) : bodyFraction(stage, stageS, false)}
            label="Your first article, from the start of setup"
          />
          <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 text-[12px] text-ink-2">
            <span>
              <span role="status">{stageLine(stage, done.size, outline.length)}</span>
              {wordsLine(stage, live?.words ?? 0) && <span> · {wordsLine(stage, live?.words ?? 0)}</span>}
            </span>
            {startedAt !== null && elapsed !== null && (
              <span className="text-[11.5px] text-ink-3">
                {/* A body still owed long after its run (retried, or picked up
                    overnight) gets no clock counting hours: only that it is
                    taking longer than usual. */}
                {elapsed < CLOCK_SHOWN_FOR_S && (
                  <>
                    <span className="font-mono tabular-nums">{clock(elapsed)}</span> ·{" "}
                  </>
                )}
                <span className={long ? "text-ink-2" : undefined}>{estimateLine(elapsed, true)}</span>
              </span>
            )}
          </p>
          {offerLeave && workspaceId && (
            <p className="m-0 text-[12.5px] text-ink-2">
              It is still being written; you can leave this page. <EmailWhenReady workspaceId={workspaceId} />
            </p>
          )}
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4">
        {showText && live ? (
          <FirstArticleText
            html={live.html}
            done={written}
            outline={shownOutline}
            // The bar's line above already says the sections are being
            // planned; this one only says where the text appears.
            waiting={written ? "Loading the text…" : stage === "writing" ? "The first words are on their way…" : "The text appears here as it is written."}
            onRevealing={onRevealing}
          />
        ) : (
          <>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-3">Outline</div>
            {article ? (
              shownOutline.length > 0 ? (
                <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {shownOutline.map((heading, i) => {
                    const isDone = done.has(i);
                    const isCurrent = writing && stage === "writing" && !isDone && i === done.size;
                    return (
                      <li
                        key={`${i}-${heading}`}
                        className="rise-in flex items-start gap-2.5 text-[13.5px] leading-[1.5]"
                        style={{ animationDelay: `${Math.min(i, 12) * 60}ms` }}
                      >
                        <span
                          className={`mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[9.5px] ${
                            isDone ? "border-ok bg-ok-soft text-ok-ink" : isCurrent ? "border-accent text-accent-ink" : "border-line text-ink-3"
                          }`}
                          aria-hidden
                        >
                          {isDone ? <Icons.check size={9} /> : isCurrent ? <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" /> : i + 1}
                        </span>
                        <span className={isDone ? "text-ink" : isCurrent ? "text-ink" : "text-ink-2"}>
                          {heading}
                          <span className="sr-only">{isDone ? " (written)" : isCurrent ? " (being written)" : ""}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="m-0 text-[12.5px] text-ink-3">This article has no section headings.</p>
              )
            ) : (
              <div className="flex flex-col gap-2" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="h-3 rounded-full bg-panel-2 motion-safe:animate-pulse" style={{ width: `${82 - i * 9}%` }} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* With the text shown, the gate's lede already says the trial is for
          editing, approving and publishing it: a lock line here said it a
          second time (UX clarity audit 2026-10-18, #4). Without the text, the
          lock is the news. */}
      {!showText && (
        <p className="m-0 mt-4 flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <Icons.lock size={12} />
          {written ? "The full text opens when your trial starts." : "The full text opens when your trial starts. It keeps being written while you decide."}
        </p>
      )}
      {article && article.more > 0 && (
        <p className="m-0 mt-1.5 text-[12px] text-ink-3">
          {article.more} more {article.more === 1 ? "draft is" : "drafts are"} written for this site and open with the trial too.
        </p>
      )}
    </section>
  );
}
