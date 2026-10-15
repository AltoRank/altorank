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
import { TRIAL_DAYS, type BillingInterval, type SelfServePlan } from "@/lib/stripe";
import { stickyOfferLine, type TrialOfferFacts } from "@/lib/billing/trial-offer";
import { EMPTY_ATTRIBUTION, attributionComplete, type AttributionDraft } from "./attribution-picker";
import { ATTRIBUTION_NOTE_MAX, ATTRIBUTION_SOURCES } from "@/lib/attribution";
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
  offer,
  held = 0,
  startedAt = null,
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
  /** What the server knows about the offer: when a trial started now ends, and whether VAT is added. */
  offer: TrialOfferFacts;
  /** Topics the plan found and held for the trial, counted: what "more" may promise. */
  held?: number;
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
  const keyword = firstArticle?.keyword ?? pending?.keyword ?? "";
  const brief = keyword ? planned.find((p) => sameTerm(p.term, keyword))?.brief ?? null : null;
  useRefreshWhileRefused(live.refused && hasArticle && !saved, router);

  // The interval is the gate's: the price box and the sticky bar open the
  // same checkout. The bar's button used to start a monthly one whatever the
  // box said (UX audit 2026-10-12, #9).
  const [interval, setInterval] = useState<BillingInterval>("month");
  // So is the plan: Managed unless the owner switches to Agency in the box.
  const [plan, setPlan] = useState<SelfServePlan>("starter");

  // The slim bar keeps the trial a click away whenever the box's own button
  // is off screen - the whole time the article is being written, since the
  // button sits under a text that grows (#10), and once it is written, after
  // the person has read into the article or gone past the button. Shown
  // whenever the button was merely below the fold, it covered the foot of a
  // finished article from the gate's first frame (review, 2026-10-12).
  const cardRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [buttonSeen, setButtonSeen] = useState<"in" | "below" | "above">("below");
  const [intoArticle, setIntoArticle] = useState(false);
  useEffect(() => {
    const button = buttonRef.current;
    const io =
      button && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            ([entry]) => setButtonSeen(entry.isIntersecting ? "in" : entry.boundingClientRect.top < 0 ? "above" : "below"),
            { rootMargin: "0px 0px -40px 0px" },
          )
        : null;
    if (io && button) io.observe(button);
    const measure = () => setIntoArticle((cardRef.current?.getBoundingClientRect().top ?? 1) < 0);
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", measure);
    };
  }, [hasArticle, ending, canBuy]);
  const writing = hasArticle && !written;
  const showBar = buttonSeen !== "in" && (writing || buttonSeen === "above" || intoArticle);
  const asks = asksForCard(ending) && canBuy;

  // Said once to a screen reader when the gate replaces the loading screen,
  // and again when the article is written: the heading itself is not live,
  // and a live region filled before it is mounted is not read out.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(words.heading), 400);
    return () => clearTimeout(t);
  }, [words.heading]);

  return (
    <>
      {notice}
      <p role="status" className="sr-only">
        {announced}
      </p>
      <div className="mb-6 text-center">
        <h1 className="m-0 mb-1.5 text-[22px] font-semibold leading-tight [text-wrap:balance]">{words.heading}</h1>
        <p className="mx-auto m-0 max-w-[520px] text-[13.5px] leading-[1.6] text-ink-2 [text-wrap:balance]">{words.lede}</p>
      </div>
      <div className="flex flex-col gap-4">
        {retry}
        {hasArticle && (
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
        <div className="scroll-mt-6" id="start-trial">
          <SetupAsk
            ending={ending}
            canBuy={canBuy}
            followUp={followUp}
            returnTo="/dashboard"
            offer={{ interval, onInterval: setInterval, plan, onPlan: setPlan, facts: offer, fullArticle, buttonRef }}
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
        <TopicBriefs planned={planned} only={keyword || undefined} />
      </div>
      {asks && showBar && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel/95 backdrop-blur" data-testid="trial-bar">
          <div className="mx-auto flex max-w-[680px] items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
            <p className="m-0 min-w-0 text-[12.5px] leading-[1.4] text-ink-2">
              <span className="hidden sm:inline">{stickyLine(written, fullArticle)} </span>
              <span>{stickyOfferLine(interval, plan)}</span>
            </p>
            <StartTrialButton returnTo="/dashboard" plan={plan} interval={interval} onStart={() => trackStep("trial_clicked")} className="shrink-0" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The slim bar's sentence. With the full article on the gate the person is
 * reading it already, so the trial is for what they cannot do here: edit,
 * approve and publish (the lede and the lock line say the same). With it
 * off, the trial is what opens the text.
 */
export function stickyLine(written: boolean, fullArticle: boolean): string {
  if (fullArticle) return "Edit, approve and publish it with the trial.";
  return written ? "Read it in full, approve it and publish it." : "Read it in full once it is written.";
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

/**
 * The one question about the person, asked once, and last: after the
 * article, the ask and everything folded under them. A single select, not
 * ten brand tiles: the tiles were the loudest block on the page and competed
 * with the trial button (UX audit 2026-10-12). Picking an answer saves it;
 * "Other" asks for a few words first. Nothing on the screen waits for it.
 */
export function AttributionAsk() {
  const [value, setValue] = useState<AttributionDraft>(EMPTY_ATTRIBUTION);
  const [saved, setSaved] = useState(false);
  const [, start] = useTransition();
  function save(next: AttributionDraft) {
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
    <div className="flex flex-col gap-2 text-[12.5px] text-ink-2 sm:flex-row sm:items-center sm:justify-center">
      <label htmlFor="attribution-source" className="shrink-0">
        Optional: where did you hear about us?
      </label>
      <select
        id="attribution-source"
        className="rounded-[7px] border border-line bg-panel px-2.5 py-1.5 text-base text-ink sm:text-[12.5px]"
        value={value.source ?? ""}
        onChange={(e) => {
          const source = (e.target.value || null) as AttributionDraft["source"];
          const next = { source, note: "" };
          setValue(next);
          if (source !== "other") save(next);
        }}
      >
        <option value="">Choose one</option>
        {ATTRIBUTION_SOURCES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {value.source === "other" && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(value);
          }}
        >
          <input
            aria-label="Where? A few words is plenty."
            className="min-w-0 flex-1 rounded-[7px] border border-line bg-panel px-2.5 py-1.5 text-base text-ink sm:text-[12.5px]"
            placeholder="Where?"
            maxLength={ATTRIBUTION_NOTE_MAX}
            value={value.note}
            onChange={(e) => setValue({ source: "other", note: e.target.value })}
          />
          <button type="submit" className="rounded-[7px] border border-line bg-bg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-panel-2">
            Save
          </button>
        </form>
      )}
    </div>
  );
}
