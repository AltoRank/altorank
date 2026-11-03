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
// never remounted). The "where did you hear about us" question left the gate
// on 2026-10-29: the Home card asks it once the trial has started.
//
// A return (a recorded visit 12 hours ago or more, lib/onboarding/
// gate-visits.ts) or a cancelled checkout gets its own first screen: what
// happened ("Welcome back. Your article is saved."), the article's title
// with a way to read it, then the offer, and the article folded under them.
// A return used to be shown the same wall as a first visit, with nothing to
// say it had been here before (Codex review, 2026-10-28).
//
// One poller (./use-first-article-live.ts) answers "is it written yet" for
// the heading, the card and the reader together; when the body lands the
// page is read again for the real word count and sources.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Icons } from "@/components/ui";
import { StartTrialButton } from "@/components/billing/start-trial-button";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";
import type { OnboardingPlanned } from "@/lib/onboarding/events";
import { asksWithOffer, type SetupEnding } from "@/lib/onboarding/setup-retry";
import { TRIAL_DAYS, type BillingInterval, type SelfServePlan } from "@/lib/stripe";
import { priceLine, type TrialOfferFacts } from "@/lib/billing/trial-offer";
import { EDITOR_FITS_QUERY, firstArticleReturn } from "@/lib/billing/checkout-return";
import { FirstArticleCardView, type PendingFirstArticle } from "./first-article-card";
import { EmailMeArticle } from "./first-look-exits";
import { SetupAsk } from "./setup-ask";
import { TopicBriefs } from "./topic-briefs";
import { useFirstArticleLive } from "./use-first-article-live";

/** "1 more topic" / "3 more topics". */
const moreTopics = (n: number) => `${n} more ${n === 1 ? "topic" : "topics"}`;

/**
 * The heading and lede over a first article, by how far it has got. Nothing
 * says "written" before it is, and nothing promises more articles than the
 * plan holds: `held` is the topics the plan found and held for the trial,
 * counted, and "the rest of the week" was printed whatever it was (UX audit
 * 2026-10-12, #5) - on the recorded run, over one scheduled article.
 */
export function articleHeading(written: boolean, fullArticle: boolean, held = 0): { heading: string; lede: string } {
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
      ? `Read it below. Start your ${TRIAL_DAYS}-day trial to edit it, approve it and publish it${held > 0 ? `, and to have the ${moreTopics(held)} we found for your site written` : ""}.`
      : `Start your ${TRIAL_DAYS}-day trial to read it in full, approve it and publish it.${held > 0 ? ` The ${moreTopics(held)} we found for your site are written once it starts, at the pace you set.` : ""}`,
  };
}

const sameTerm = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why the gate opens on its return screen: a recorded earlier visit, or a checkout just cancelled. */
export type GateWelcome = "returning" | "cancelled";

/** The return screen's first line. A cancelled checkout says that first, whenever it was. */
export function welcomeLine(welcome: GateWelcome): string {
  return welcome === "cancelled" ? "Your trial hasn't started. Nothing was charged." : "Welcome back. Your article is saved.";
}

/** The sticky bar's height before it has been measured: one line of price over a full-width button. */
const BAR_HEIGHT_GUESS = 104;

export function GateTop({
  workspaceId,
  canBuy,
  ending,
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
  offer,
  held = 0,
  nextArticles = [],
  welcome = null,
  startedAt = null,
}: {
  workspaceId: string;
  canBuy: boolean;
  ending: SetupEnding;
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
  /** What the server knows about the offer: when a trial started now ends, and whether VAT is added. */
  offer: TrialOfferFacts;
  /** Topics the plan found and held for the trial, counted: what "more" may promise. */
  held?: number;
  /** The site's next topics by name, for the offer's "Your next articles" (lib/onboarding/next-articles.ts). */
  nextArticles?: string[];
  /** Opens on the return screen: the person has been here before, or just cancelled checkout. */
  welcome?: GateWelcome | null;
  /** When the run started, on this browser's clock: the one clock carries on into the card. */
  startedAt?: number | null;
}) {
  const router = useRouter();
  const hasArticle = firstArticle !== null || pending !== null;
  const outlined = firstArticle ? firstArticle.state === "outlined" : pending?.outlined === true;
  const polled = useFirstArticleLive({
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
  // The page read the finished text itself after the poller started (the
  // run screen reads the page again when the run ends): the poller then
  // stops, and its own answer may still be the empty one from before the
  // body was saved. The page's text wins over an empty poll, so a body
  // written in the moment between the two is never shown as "the text
  // appears here" (found on the stubbed run, 2026-10-12).
  const live = initialHtml !== null && !polled.html ? { ...polled, html: initialHtml, done: true, refused: false } : polled;
  const saved = hasArticle && (!outlined || live.done);
  // With the full text on the gate, "written" waits for the text: in hand
  // (a loaded server took 8-20s to hand it over, under "Your first article
  // is written" and an empty box) and typed out to its end. Until then the
  // heading, the badge and the trial bar stay as they were while it was
  // being written (review, 2026-10-12).
  const [revealing, setRevealing] = useState(false);
  const settling = saved && fullArticle && !live.refused && (!live.html || revealing);
  const written = saved && !settling;
  const words = hasArticle && ending === "article" ? articleHeading(written, fullArticle, held) : { heading, lede };
  // The return screen needs an article to come back to: a finished one,
  // read off the row, so it does not flicker while the text loads.
  const returnView = welcome !== null && ending === "article" && firstArticle?.state === "written";
  const [articleOpen, setArticleOpen] = useState(!returnView);
  const articleRef = useRef<HTMLDetailsElement | null>(null);
  const keyword = firstArticle?.keyword ?? pending?.keyword ?? "";
  const brief = keyword ? planned.find((p) => sameTerm(p.term, keyword))?.brief ?? null : null;
  useRefreshWhileRefused(live.refused && hasArticle && !saved, router);

  // The interval is the gate's: the price box and the sticky bar open the
  // same checkout. The bar's button used to start a monthly one whatever the
  // box said (UX audit 2026-10-12, #9).
  const [interval, setInterval] = useState<BillingInterval>("month");
  // So is the plan: Managed unless the owner switches to Agency in the box.
  const [plan, setPlan] = useState<SelfServePlan>("starter");

  // The slim bar keeps the trial a click away whenever the offer is off
  // screen - the whole time the article is being written, since the offer
  // sits under a text that grows (#10), and once it is written, after the
  // person has read into the article or gone past the offer. It is hidden
  // whenever any of the offer's box is in view above the bar, so there is
  // never a second Start trial button on screen: watching only the box's
  // button, 40px clear of the edge, showed both on a phone (Codex review,
  // 2026-10-28). The bottom of the screen the bar covers - its height, safe
  // area included, as measured - does not count as in view.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const offerRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(BAR_HEIGHT_GUESS);
  const [offerSeen, setOfferSeen] = useState<"in" | "below" | "above">("below");
  const [intoArticle, setIntoArticle] = useState(false);
  useEffect(() => {
    const offer = offerRef.current;
    const io =
      offer && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            ([entry]) => setOfferSeen(entry.isIntersecting ? "in" : entry.boundingClientRect.top < 0 ? "above" : "below"),
            { rootMargin: `0px 0px -${Math.round(barHeight)}px 0px` },
          )
        : null;
    if (io && offer) io.observe(offer);
    const measure = () => setIntoArticle((cardRef.current?.getBoundingClientRect().top ?? 1) < 0);
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", measure);
    };
  }, [hasArticle, ending, canBuy, barHeight]);
  const writing = hasArticle && !written;
  const showBar = offerSeen !== "in" && (writing || offerSeen === "above" || intoArticle);
  const asks = asksWithOffer(ending) && canBuy;
  const afterCheckout = firstArticleReturn(firstArticle?.id, useEditorFits());
  // The bar's real height, once it is on screen: the line can wrap, and the
  // safe area under a phone's home bar is part of what it covers.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBarHeight(bar.getBoundingClientRect().height || BAR_HEIGHT_GUESS));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [asks, showBar]);
  const title = firstArticle?.title || firstArticle?.keyword || "";
  const readArticle = () => {
    setArticleOpen(true);
    // After the fold has opened, so the scroll lands on its content.
    requestAnimationFrame(() => articleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // Said once to a screen reader when the gate replaces the loading screen,
  // and again when the article is written: the heading itself is not live,
  // and a live region filled before it is mounted is not read out.
  const [announced, setAnnounced] = useState("");
  const shownHeading = returnView && welcome ? welcomeLine(welcome) : words.heading;
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(shownHeading), 400);
    return () => clearTimeout(t);
  }, [shownHeading]);

  // The ask, held in view and scrolling on its own when taller than the
  // screen: Stripe's form opens here at about 820px, and a pinned rail that
  // tall hid its Start trial button until the article ran out. On the return
  // screen it comes before the article, in the page as well as on a phone's
  // screen; from lg it is the rail on the right either way.
  const rail = (
    <aside aria-label="Your trial" className={`flex flex-col gap-4 ${returnView ? "lg:order-last" : ""} lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:w-[var(--gate-rail)] lg:shrink-0 lg:overflow-y-auto lg:overscroll-contain [&>*]:shrink-0`}>
      <div className="scroll-mt-6" id="start-trial" ref={offerRef}>
        <SetupAsk
          ending={ending}
          canBuy={canBuy}
          returnTo={afterCheckout}
          offer={{ interval, onInterval: setInterval, plan, onPlan: setPlan, facts: offer, nextArticles }}
          workspaceId={workspaceId}
          // The soft exit, under the button and quieter than it: a link
          // back by email, never the text (UX audit 2026-10-12, #3). Only
          // once there is an article to come back to: offered from the
          // gate's first frame it mailed "yours to read" for an outline,
          // and the one send per article was spent before the text existed
          // (review, 2026-10-12). While it is written, the long-run "Email
          // me when it's ready" covers that need.
          below={canBuy && hasArticle && written ? <EmailMeArticle workspaceId={workspaceId} className="mt-3 block w-full text-center" /> : null}
        />
      </div>
    </aside>
  );

  return (
    <>
      {notice}
      <p role="status" className="sr-only">
        {announced}
      </p>
      {returnView && welcome ? (
        <div className="mb-4 max-w-[640px]" data-testid="gate-return">
          <h1 className="m-0 text-[22px] font-semibold leading-tight [text-wrap:balance]">{welcomeLine(welcome)}</h1>
          <div className="mt-3 rounded-[10px] border border-line bg-panel px-4 py-3">
            <p className="m-0 text-[11px] uppercase tracking-wide text-ink-3">Your first article</p>
            <p className="m-0 mt-1 text-[15.5px] font-semibold leading-snug text-ink [text-wrap:balance]">{title}</p>
            <button
              type="button"
              onClick={readArticle}
              className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent-ink underline decoration-accent/40 underline-offset-[3px] hover:decoration-accent"
            >
              Read your article
              <Icons.arrow size={12} />
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-6 max-w-[640px]">
          <h1 className="m-0 mb-1.5 text-[22px] font-semibold leading-tight [text-wrap:balance]">{words.heading}</h1>
          <p className="m-0 text-[13.5px] leading-[1.6] text-ink-2 [text-wrap:balance]">{words.lede}</p>
        </div>
      )}
      {/* Two columns from lg: the article, and beside it the ask and why this
          article, held in view while the article scrolls. The card form opens
          in that rail (Embedded Checkout, inline), beside the article and never
          over it. Below lg the rail follows the article, and its button and
          the slim bar both open the same checkout in a sheet: one form at a
          time (components/billing/trial-offer.tsx INLINE_CHECKOUT_QUERY). */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        {returnView && rail}
        <div className="flex min-w-0 flex-col gap-4 lg:flex-1">
          {retry}
          {hasArticle && returnView && (
            // The article, saved and whole, folded under the offer: opened
            // by "Read your article" or its own summary. Never regenerated:
            // it is the same card over the same row.
            <details
              ref={articleRef}
              open={articleOpen}
              onToggle={(e) => setArticleOpen(e.currentTarget.open)}
              className="scroll-mt-4 rounded-[10px] border border-line bg-panel [&[open]]:border-transparent [&[open]]:bg-transparent"
            >
              <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-medium text-ink [&::-webkit-details-marker]:hidden [[open]>&]:sr-only">
                Show the full article
              </summary>
              <div ref={cardRef}>
                <FirstArticleCardView
                  article={firstArticle}
                  pending={null}
                  brief={brief}
                  live={live}
                  readable={fullArticle}
                  startedAt={startedAt}
                  workspaceId={canBuy ? workspaceId : undefined}
                  settling={settling}
                  onRevealing={setRevealing}
                />
              </div>
            </details>
          )}
          {hasArticle && !returnView && (
            <div ref={cardRef}>
              <FirstArticleCardView
                article={firstArticle}
                pending={firstArticle ? null : pending}
                brief={brief}
                live={live}
                readable={fullArticle}
                startedAt={startedAt}
                workspaceId={canBuy ? workspaceId : undefined}
                settling={settling}
                onRevealing={setRevealing}
              />
            </div>
          )}
          {/* Why this article sits under it, not in the rail: its heading
              outranked the trial offer's beside it (UX clarity audit
              2026-10-18, #4). */}
          <TopicBriefs planned={planned} only={keyword || undefined} />
        </div>
        {!returnView && rail}
      </div>
      {asks && showBar && (
        <div
          ref={barRef}
          className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
          data-testid="trial-bar"
        >
          {/* The price line over the button, as in the box: never a button
              without what it costs right above it. */}
          <div className="mx-auto max-w-[680px] px-4 pb-2.5 pt-2 sm:px-6">
            <p className="m-0 text-[12px] leading-[1.4] text-ink-2">{priceLine(interval, offer, plan)}</p>
            <StartTrialButton returnTo={afterCheckout} plan={plan} interval={interval} surface="sticky_bar" className="mt-1.5 w-full justify-center" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Whether this screen is wide enough for the editor without a sideways
 * scroll. The server has no viewport and says no, which lands on the
 * dashboard as the gate always did; so does a browser without matchMedia.
 * The answer is only used when checkout opens.
 */
function useEditorFits(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia?.(EDITOR_FITS_QUERY);
      query?.addEventListener?.("change", onChange);
      return () => query?.removeEventListener?.("change", onChange);
    },
    () => window.matchMedia?.(EDITOR_FITS_QUERY).matches ?? false,
    () => false,
  );
}

/**
 * The poller was refused (a member who is not the owner, or a run whose
 * article is not the site's first): nothing live will say the body landed,
 * so the page is read again every 20 seconds until it does, as it was before
 * the poller existed. Stops after ten minutes.
 */
function useRefreshWhileRefused(active: boolean, router: { refresh: () => void }): void {
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 10 * 60_000) clearInterval(timer);
      else router.refresh();
    }, 20_000);
    return () => clearInterval(timer);
  }, [active, router]);
}
