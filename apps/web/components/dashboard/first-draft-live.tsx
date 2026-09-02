"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui";
import type { Article } from "@/lib/types";

/**
 * The first thing a new workspace has to say for itself.
 *
 * Onboarding starts the first draft in the background the moment the site and
 * voice are submitted, but the overview said the opposite - "drafts are written
 * on the daily schedule; to get one now, open Articles and choose New article" -
 * so the one moment the product is doing exactly what it promised looked like
 * the moment it was doing nothing. This is that minute, shown.
 *
 * Three states, decided here rather than by the parent, because they are
 * mutually exclusive and the old code got that wrong: a workspace mid-draft has
 * an article row already, so `articles.length === 0` was false and the "what
 * happens next" card vanished before anything had appeared to replace it.
 *
 * No new schema. `articles.status` already moves 'drafting' -> 'review', and
 * migration 022 already stores why the keyword was chosen, at the moment it was
 * chosen. Both were being thrown away by the UI.
 */

const POLL_MS = 3_000;

/**
 * Ten minutes, then stop and say so. A generation that dies between its two
 * failure writes leaves the article on 'drafting' forever - generation_jobs
 * rejects the status "error" that lib/content/generate.ts writes on the
 * article-save path, so the job row never leaves 'running' either. Without a
 * ceiling this component would poll a dead draft until the tab closed.
 */
const GIVE_UP_MS = 10 * 60_000;

export function FirstDraftLive({
  articles,
  keywordCount,
  autoGenerate,
  now,
}: {
  articles: Article[];
  keywordCount: number;
  autoGenerate?: boolean | null;
  /**
   * The server's clock at render, refreshed by every poll. Staleness is
   * measured against this rather than a client timer so that it survives a
   * reload - a draft that died twenty minutes ago should still read as dead,
   * not restart the countdown because the tab was reopened - and so the
   * server and client agree on first paint.
   */
  now: number;
}) {
  const router = useRouter();
  const drafting = articles.find((a) => a.status === "drafting");
  const draftingId = drafting?.id ?? null;
  const stalled =
    drafting != null && now - new Date(drafting.created_at).getTime() > GIVE_UP_MS;

  useEffect(() => {
    if (!draftingId || stalled) return;
    const poll = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(poll);
  }, [draftingId, stalled, router]);

  if (drafting) {
    return (
      <Card flush className="p-5">
        <div className="flex items-center gap-2.5">
          {!stalled && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
          )}
          <div className="text-[13px] font-medium text-ink">
            {stalled ? "This draft has stopped responding" : "Writing your first draft"}
          </div>
          {drafting.keyword && !stalled && (
            <span className="font-mono text-[11.5px] text-ink-3">{drafting.keyword}</span>
          )}
        </div>

        {stalled ? (
          <p className="m-0 mt-2 max-w-[62ch] text-[12.5px] leading-relaxed text-ink-2">
            It has been ten minutes with no result, so this stopped checking.
            Nothing was published and nothing was charged for a draft that never
            arrived. Open{" "}
            <Link href="/articles" className="text-accent-ink underline decoration-line underline-offset-[3px]">
              Articles
            </Link>{" "}
            to start another.
          </p>
        ) : (
          <>
            <p className="m-0 mt-2 max-w-[62ch] text-[12.5px] leading-relaxed text-ink-2">
              Researching the {keywordCount.toLocaleString()} keywords tracked here,
              then drafting, fact-checking and scoring. It lands in your review
              queue when it is done — nothing publishes without your approval.
            </p>
            {/* A shape, not a spinner: the draft is what is being made, so the
                placeholder is paragraph-shaped and the reader knows what to
                expect in the space it occupies. */}
            <div className="mt-4 flex flex-col gap-2" aria-hidden>
              {[100, 92, 96, 64].map((w, i) => (
                <div
                  key={i}
                  className="h-2.5 animate-pulse rounded-full bg-panel-2"
                  style={{ width: `${w}%`, animationDelay: `${i * 140}ms` }}
                />
              ))}
            </div>
            <span className="sr-only" role="status">
              Writing your first draft. This page updates on its own.
            </span>
          </>
        )}
      </Card>
    );
  }

  // Nothing written and nothing in flight.
  if (articles.length === 0) {
    return (
      <Card flush className="p-5">
        <div className="text-[13px] font-medium text-ink mb-1">What happens next</div>
        <div className="max-w-[68ch] text-[12.5px] leading-relaxed text-ink-2">
          The pipeline picks the best-scoring keyword from the{" "}
          {keywordCount.toLocaleString()} tracked here, writes a draft,
          fact-checks it and scores it, then puts it in your{" "}
          <Link href="/articles?status=review" className="text-accent-ink underline decoration-line underline-offset-[3px]">
            review queue
          </Link>
          . Nothing publishes until you approve it.{" "}
          {autoGenerate ? (
            <>The next draft is written on the daily schedule.</>
          ) : (
            <>
              Automatic drafting is off, so nothing will be written until you turn
              it on in Settings, or start one from{" "}
              <Link href="/articles" className="text-accent-ink underline decoration-line underline-offset-[3px]">
                Articles
              </Link>
              .
            </>
          )}
        </div>
      </Card>
    );
  }

  // Written. Say why this keyword, using the reasons captured when it was
  // chosen - not recomputed now, which would answer a different question.
  const newest = articles[0];
  const reasons = newest.selection_reasons ?? [];
  if (reasons.length === 0) return null;

  return (
    <Card flush className="p-5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <div className="text-[13px] font-medium text-ink">
          Chose{" "}
          <Link
            href={`/articles/${newest.id}`}
            className="text-accent-ink underline decoration-line underline-offset-[3px]"
          >
            {newest.keyword || newest.title}
          </Link>
        </div>
        {newest.selection_score != null && (
          <span className="font-mono text-[11px] text-ink-3">
            score {newest.selection_score.toFixed(1)} of the candidates in that run
          </span>
        )}
      </div>

      <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
        {reasons.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-2">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-4" />
            {r}
          </li>
        ))}
      </ul>
    </Card>
  );
}
