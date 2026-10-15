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
import { plainTopicLabel } from "@/lib/keyword-research/topic-labels";
import { bodyFraction, BODY_STAGE_S, type BodyStage } from "@/lib/onboarding/setup-progress";
import { ProgressBar, useNow } from "./progress-bar";
import { FirstArticleText } from "./first-article-reader";
import type { FirstArticleLive } from "./use-first-article-live";

/** "Sep 7" from a YYYY-MM-DD, in UTC so the day the planner wrote is the day shown. */
function calendarDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const n = (x: number) => x.toLocaleString("en-US");

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

export function FirstArticleCardView({
  article,
  pending = null,
  brief,
  live,
  readable = false,
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
  const done = new Set(written ? outline.map((_, i) => i) : live?.sectionsDone ?? []);
  const stage = live?.stage ?? null;
  const stageS = live?.stageSince && now ? (now - live.stageSince) / 1000 : 0;
  const purpose = writtenFor(brief);
  const showText = readable && live && !live.refused;

  return (
    <section aria-label="Your first article" className="rise-in rounded-[10px] border border-line bg-panel p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Your first article</span>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${written ? "bg-ok-soft text-ok-ink" : "border border-line text-ink-2"}`}>
          {written ? <Icons.check size={10} /> : <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />}
          {written ? "Written" : "Being written"}
        </span>
      </div>
      <h2 className="m-0 text-[19px] font-semibold leading-snug text-ink">{title}</h2>
      {purpose && (
        <p className="m-0 mt-1.5 text-[13px] leading-[1.55] text-ink-2">
          <span className="text-ink-3">Written for: </span>
          {purpose}
        </p>
      )}
      {article && article.labels.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {article.labels.map((raw) => {
            const l = plainTopicLabel(raw);
            return (
              <li key={raw.label} className="text-[12px] leading-[1.5] text-ink-2">
                <span className={`mr-1.5 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] ${raw.label === "Top of funnel" ? "text-ink-3" : "text-warn"}`}>{l.label}</span>
                {l.explain}
              </li>
            );
          })}
        </ul>
      )}

      <dl className="m-0 mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <Fact label="Target search" wide>{keyword || "—"}</Fact>
        <Fact label="Scheduled for">
          {article ? (article.scheduledDate ? calendarDay(article.scheduledDate) : "Not on the calendar yet") : "…"}
        </Fact>
        <Fact label="Length">
          {finalWords > 0
            ? `${n(finalWords)} words`
            : target > 0
              ? `About ${n(target)} words`
              : "—"}
        </Fact>
        {/* Counted from the article's own links once written; while it is
            being written, the pages its outline plans to cite. A zero is
            not printed: it read as "no research" (recorded 2026-10-12). */}
        {article && article.sources > 0 && <Fact label={written && article.state === "written" ? "Sources cited" : "Sources planned"}>{n(article.sources)}</Fact>}
      </dl>

      {writing && (
        <div className="mt-4 flex flex-col gap-1.5">
          <ProgressBar fraction={bodyFraction(stage, stageS, false)} label="The article being written" />
          <p className="m-0 text-[12px] text-ink-2">
            <span role="status">{stageLine(stage, done.size, outline.length)}</span>
            {wordsLine(stage, live?.words ?? 0) && <span> · {wordsLine(stage, live?.words ?? 0)}</span>}
            <span className="text-ink-3"> · usually about {Math.round((BODY_STAGE_S.thinking + BODY_STAGE_S.writing + BODY_STAGE_S.finishing) / 60)} minutes</span>
          </p>
        </div>
      )}

      <div className="mt-5 border-t border-line pt-4">
        {showText && live ? (
          <FirstArticleText
            html={live.html}
            done={written}
            arrivalCps={live.arrivalCps}
            outline={outline}
            // The bar's line above already says the sections are being
            // planned; this one only says where the text appears.
            waiting={stage === "writing" ? "The first words are on their way…" : "The text appears here as it is written."}
          />
        ) : (
          <>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-3">Outline</div>
            {article ? (
              outline.length > 0 ? (
                <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {outline.map((heading, i) => {
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

      <p className="m-0 mt-4 flex items-center gap-1.5 text-[12.5px] text-ink-2">
        <Icons.lock size={12} />
        {showText
          ? "Read-only. Editing, approving and publishing open when your trial starts."
          : written
            ? "The full text opens when your trial starts."
            : "The full text opens when your trial starts. It keeps being written while you decide."}
      </p>
      {article && article.more > 0 && (
        <p className="m-0 mt-1.5 text-[12px] text-ink-3">
          {article.more} more {article.more === 1 ? "draft is" : "drafts are"} written for this site and open with the trial too.
        </p>
      )}
    </section>
  );
}
