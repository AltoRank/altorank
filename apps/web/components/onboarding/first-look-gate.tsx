"use client";

// ---------------------------------------------------------------------------
// The gate: the first article, then the ask, then why - and the rest folded
// ---------------------------------------------------------------------------
//
// The order is the point, and it is the reverse of what it was. Recorded on
// 2026-10-12: the card ask and a ten-button "where did you hear about us"
// sat above the article, so on a laptop only its title was above the fold
// and on a phone none of it; the dense run log, the calendar and the site
// report sat on the same page below; and the heading, the card and the log
// disagreed about whether the article was written.
//
// Now, top to bottom: the article (title, who it is for, its outline ticking
// off as it is written - or, with PRETRIAL_FULL_ARTICLE on, its text as it
// is typed), the trial offer directly under it, then why this article. The
// setup log, the calendar and the site report are folded below (the caller
// renders them between `GateTop` and `GateBottom`, so the run's poller is
// never remounted), and the one question about the person is last.
//
// One poller (./use-first-article-live.ts) answers "is it written yet" for
// the heading, the card and the reader together; when the body lands the
// page is read again for the real word count and sources.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAttribution } from "@/app/actions/attribution";
import { StartTrialButton } from "@/components/billing/start-trial-button";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";
import type { OnboardingPlanned } from "@/lib/onboarding/events";
import { asksForCard, type SetupEnding } from "@/lib/onboarding/setup-retry";
import { trackStep } from "@/lib/onboarding/track-step";
import { TRIAL_DAYS } from "@/lib/stripe";
import { AttributionPicker, EMPTY_ATTRIBUTION, attributionComplete, type AttributionDraft } from "./attribution-picker";
import { FirstArticleCardView, type PendingFirstArticle } from "./first-article-card";
import { SetupAsk } from "./setup-ask";
import { TopicBriefs } from "./topic-briefs";
import { useFirstArticleLive } from "./use-first-article-live";

/** The heading and lede over a first article, by how far it has got. Nothing says "written" before it is. */
export function articleHeading(written: boolean, fullArticle: boolean): { heading: string; lede: string } {
  if (!written) {
    return {
      heading: "Your first article is being written",
      lede: fullArticle
        ? `Read it below as it is written. Start your ${TRIAL_DAYS}-day trial to edit it, approve it and publish it.`
        : `Its outline is below; each section ticks off as it is written. Start your ${TRIAL_DAYS}-day trial to read it in full, approve it and publish it.`,
    };
  }
  return {
    heading: "Your first article is written",
    lede: fullArticle
      ? `Read it below. Start your ${TRIAL_DAYS}-day trial to edit it, approve it and publish it, and to write the rest of the week.`
      : `Start your ${TRIAL_DAYS}-day trial to read it in full, approve it and publish it. The rest of the week is written once the trial starts.`,
  };
}

const sameTerm = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function GateTop({
  workspaceId,
  canBuy,
  ending,
  followUp,
  heading,
  lede,
  retry = null,
  firstArticle,
  pending = null,
  planned,
  fullArticle = false,
  initialHtml = null,
  onBodyDone,
  notice = null,
}: {
  workspaceId: string;
  canBuy: boolean;
  ending: SetupEnding;
  followUp: boolean;
  /** For an ending with no article; an article's own heading follows it being written. */
  heading: string;
  lede: string;
  retry?: React.ReactNode;
  firstArticle: FirstArticleCard | null;
  pending?: PendingFirstArticle | null;
  planned: OnboardingPlanned[];
  fullArticle?: boolean;
  /** The saved text, read on the server when the article was already written (switch on, owner). */
  initialHtml?: string | null;
  /** Told once when the body lands, after the page has been asked to read itself again. */
  onBodyDone?: () => void;
  /** A line above everything else (the checkout was cancelled). */
  notice?: React.ReactNode;
}) {
  const router = useRouter();
  const hasArticle = firstArticle !== null || pending !== null;
  const outlined = firstArticle ? firstArticle.state === "outlined" : pending?.outlined === true;
  const live = useFirstArticleLive({
    workspaceId,
    mode: fullArticle ? "text" : "counts",
    // Something to watch: a body still being written, or (switch on) a
    // written one whose text the page did not already carry.
    enabled: hasArticle && (outlined || (fullArticle && initialHtml === null)),
    initial: initialHtml !== null ? { html: initialHtml, done: true } : undefined,
    onDone: () => {
      router.refresh();
      onBodyDone?.();
    },
  });
  const written = hasArticle && (!outlined || live.done);
  const words = hasArticle && ending === "article" ? articleHeading(written, fullArticle) : { heading, lede };
  const keyword = firstArticle?.keyword ?? pending?.keyword ?? "";
  const brief = keyword ? planned.find((p) => sameTerm(p.term, keyword))?.brief ?? null : null;

  // The ask under the article can be a long way down once the text is in;
  // a slim bar keeps it a click away while it is off screen.
  const askRef = useRef<HTMLDivElement | null>(null);
  const [askInView, setAskInView] = useState(true);
  useEffect(() => {
    const el = askRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setAskInView(entry.isIntersecting), { rootMargin: "0px 0px -40px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const asks = asksForCard(ending) && canBuy;

  return (
    <>
      {notice}
      <div className="mb-6 text-center">
        <h1 className="m-0 mb-1.5 text-[22px] font-semibold leading-tight">{words.heading}</h1>
        <p className="mx-auto m-0 max-w-[520px] text-[13.5px] leading-[1.6] text-ink-2">{words.lede}</p>
      </div>
      <div className="flex flex-col gap-4">
        {retry}
        {hasArticle && (
          <FirstArticleCardView article={firstArticle} pending={firstArticle ? null : pending} brief={brief} live={hasArticle ? live : null} readable={fullArticle} />
        )}
        <div ref={askRef} className="scroll-mt-6" id="start-trial">
          <SetupAsk ending={ending} canBuy={canBuy} followUp={followUp} returnTo="/dashboard" />
        </div>
        <TopicBriefs planned={planned} only={keyword || undefined} />
      </div>
      {asks && !askInView && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel/95 backdrop-blur">
          <div className="mx-auto flex max-w-[680px] items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
            <p className="m-0 min-w-0 text-[12.5px] leading-[1.4] text-ink-2">
              {written ? "Read it in full, approve it and publish it." : "Read it in full once it is written."}{" "}
              <span className="hidden sm:inline">{TRIAL_DAYS} days free, cancel any time.</span>
            </p>
            <StartTrialButton returnTo="/dashboard" onStart={() => trackStep("trial_clicked")} className="shrink-0" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The one question about the person, asked once, and last: after the
 * article, the ask and everything folded under them. One click saves it;
 * nothing on the screen waits for it. The copy says why we ask, because a
 * question with no visible reason gets the answer that closes it fastest.
 */
export function AttributionAsk() {
  const [value, setValue] = useState<AttributionDraft>(EMPTY_ATTRIBUTION);
  const [saved, setSaved] = useState(false);
  const [, start] = useTransition();
  function onChange(next: AttributionDraft) {
    setValue(next);
    if (!next.source || !attributionComplete(next)) return;
    const source = next.source;
    start(async () => {
      try {
        await saveAttribution(source, next.note);
        setSaved(true);
      } catch {
        // Optional by design: a failed save is not a thing to interrupt the
        // trial ask with.
      }
    });
  }
  if (saved) {
    return <p className="m-0 text-center text-[12.5px] text-ink-3">Thanks. That is the one thing we asked about you.</p>;
  }
  return (
    <div className="rounded-[10px] border border-line bg-panel p-5">
      <p className="m-0 mb-3 text-[12.5px] leading-[1.5] text-ink-2">
        <strong className="font-medium text-ink">One question: where did you hear about us?</strong> Optional. It is the only way
        we can tell whether an AI answer sent you here, which is the thing we sell.
      </p>
      <AttributionPicker value={value} onChange={onChange} columns={5} />
    </div>
  );
}
