"use client";

// ---------------------------------------------------------------------------
// The onboarding wizard
// ---------------------------------------------------------------------------
//
// Five steps over one idea, then one question. The site is read first, and every
// screen after that is verification rather than authorship. Chips arrive filled,
// the description arrives written, and the person deletes what is wrong.
//
// Three rules, each from watching the first version fail:
//
// 1. Every screen writes somewhere. Sitemap, blog, tone and instructions all
//    persist on Continue; nothing on screen is decorative.
// 2. Never claim what did not happen. If the site could not be read, say so,
//    with the reason and a retry, and let the person type. If the sitemap was
//    not found, ask for it instead of printing a guess as a discovery.
// 3. It ends on a plan. Finishing runs the same pipeline the dashboard uses
//    (voice, keywords, a month of scheduled articles, the first draft) and
//    shows it happening, with the deferred setup offered as things to do while
//    you wait.
//
// The CMS step is still the last thing asked about the site and still skippable.
// A credential before value is asking someone to prove they own a site before
// they have a reason to care.
//
// After it, once per account, comes the only question that is about the person:
// where they heard of us. It is last because by then they have watched the
// product read their site and have a reason to answer honestly; it is asked
// and one click is not a wall.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import {
  proposeProfile,
  resolveCompetitor,
  suggestCompetitors,
  saveProfile,
  discoverSiteDetails,
  saveSiteDetails,
  completeWizard,
} from "@/app/actions/onboarding-wizard";
import type { SiteDetails } from "@/lib/onboarding/output-settings";
import type { OnboardingHeld } from "@/lib/onboarding/events";
import { EMPTY_PROFILE, type BusinessProfile } from "@/lib/onboarding/profile-shape";
import type { InferenceReason } from "@/lib/onboarding/business-profile";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
// The forms themselves live in components/settings: every wizard screen is
// also a permanent Settings tab, and one copy of each form keeps them in step.
import { BusinessFields } from "@/components/settings/business-fields";
import { AudienceList, OfferingList } from "@/components/settings/audience-fields";
import { CompetitorStep } from "@/components/onboarding/competitor-step";
import { trackStep } from "@/lib/onboarding/track-step";
import type { CompetitorSuggestion, RivalSize } from "@/lib/onboarding/competitor-suggestions";
import { SiteFields } from "@/components/settings/site-fields";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import {
  onboardingOutcome,
  shouldResumeRun,
  stateFromRun,
  type OnboardingPlanned,
  type OnboardingRunSnapshot,
  type OnboardingState,
} from "@/lib/onboarding/events";
import { freeAllowanceClause } from "@/lib/onboarding/copy";
import { FirstLookReportView } from "@/components/onboarding/first-look-report";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";
import { OPEN_SETUP, runStateOf, setupEnding, type PreTrialSetup, type SetupEnding } from "@/lib/onboarding/setup-retry";
import { NOTHING_PLANNED_HEADING, nothingPlannedLede } from "@/components/onboarding/setup-ask";
import { AttributionAsk, GateTop } from "@/components/onboarding/first-look-gate";
import { Fold } from "@/components/onboarding/fold";
import { signOut } from "@/app/actions/auth";
import { TRIAL_DAYS } from "@/lib/stripe";
import posthog from "posthog-js";

export type Destination = { id: string; name: string; description: string | null };

export function OnboardingWizard({
  workspaceId,
  userId,
  userEmail,
  userProfileName,
  domain,
  freeDrafts,
  trialEligible = false,
  canBuy = false,
  initialProfile,
  initialSite,
  askAttribution,
  alreadyOnboarded = false,
  gatePlan = [],
  gateHeld = null,
  gateReport = null,
  firstArticle = null,
  firstArticleWriting = false,
  fullArticle = false,
  initialHtml = null,
  preTrialSetup = OPEN_SETUP,
  initialRun = null,
  otherSites = [],
}: {
  workspaceId: string;
  userId: string;
  userEmail?: string;
  userProfileName?: string;
  domain: string;
  weeklyLimit: number;
  /**
   * Drafts this account may still have written before it needs a plan, or
   * null when it is unmetered (self-host, operator, an active plan).
   *
   * `buildPlan` fills a 30-day horizon at `weeklyLimit`, so at the free tier's
   * pace of 7 the wizard promised thirty articles against an entitlement of
   * seven - and 23 of the 30 squares render grey with `frozenReason` the first
   * time the calendar is opened. Nothing said so (P1-A1).
   */
  freeDrafts: number | null;
  /**
   * Whether the run screen may end with the card ask. True on a fresh cloud
   * account; false on self-host, for operators, and once the account has had
   * its trial (lib/billing/trial.ts).
   */
  trialEligible?: boolean;
  canBuy?: boolean;
  initialProfile: BusinessProfile | null;
  initialSite: SiteDetails;
  /** Whether the account has yet to say where it heard of us; asked once, on the trial screen. */
  askAttribution: boolean;
  /**
   * The workspace's latest onboarding run, read by the page. A run still
   * going, or one that finished in the last hour, opens on the run screen
   * rather than on step 1 - which is what makes a reload mid-run land back
   * on the phases so far instead of restarting the wizard.
   */
  /**
   * This workspace has been through setup before. Set when the dashboard's
   * trial gate sent the person here for the card: they must not be handed the
   * wizard, whose Finish starts a fresh run.
   */
  alreadyOnboarded?: boolean;
  /** The month already planned for this account, shown locked on the gate. */
  gatePlan?: OnboardingPlanned[];
  /** Topics held for the trial, shown locked beside the plan on the gate. */
  gateHeld?: OnboardingHeld | null;
  /** The analysis already run on this account's site, shown open on the gate. */
  gateReport?: FirstLookReport | null;
  /**
   * The workspace's first written article, as its shape only: title, outline,
   * length, sources (lib/onboarding/first-article.ts). Null when there is
   * none, or when this account is not before its trial.
   */
  firstArticle?: FirstArticleCard | null;
  /** An article is being written right now, so a retry must not be offered. */
  firstArticleWriting?: boolean;
  /**
   * PRETRIAL_FULL_ARTICLE is on and this person owns the account: the gate
   * shows the first article in full, read-only, as it is written
   * (lib/onboarding/first-article-body.ts). Decided on the server.
   */
  fullArticle?: boolean;
  /** The first article's text, when it is already written and `fullArticle` lets the owner read it. */
  initialHtml?: string | null;
  /** Whether setup may run again before the trial, and whether the first article was attempted. */
  preTrialSetup?: PreTrialSetup;
  initialRun?: OnboardingRunSnapshot | null;
  /**
   * The person's sites in OTHER accounts that the trial gate lets them into.
   * Someone invited to a paying account who also owns a never-trialed one
   * reaches this card for their own site; these are their way back to the
   * work they were invited to do, beside signing out (round-4 review).
   */
  otherSites?: OtherSite[];
}) {
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (identifiedUserId.current === userId) return;
    posthog.identify(userId, {
      ...(userEmail ? { email: userEmail } : {}),
      ...(userProfileName ? { name: userProfileName } : {}),
    });
    identifiedUserId.current = userId;
  }, [userEmail, userId, userProfileName]);
  const [profile, setProfile] = useState<BusinessProfile | null>(initialProfile);
  const [site, setSite] = useState<SiteDetails>(initialSite);
  // Null profile and not yet asked = we are about to read the site.
  const [reading, setReading] = useState(initialProfile === null);
  const [readFailure, setReadFailure] = useState<InferenceReason | null>(null);
  const [readFailureMessage, setReadFailureMessage] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<SiteDiscovery | null | "pending">(initialSite.sitemapUrl || initialSite.blogRootUrl ? null : "pending");
  // A run found on load is resumed; otherwise Finish starts one.
  const [resumed] = useState(() => (initialRun && shouldResumeRun(initialRun, Date.now()) ? initialRun : null));
  const [running, setRunning] = useState(resumed !== null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Rivals proposed for the competitor step, looked up once the profile is
  // read (the lookup starts from the profile's offerings), and the size of
  // every host the person has chosen, from suggestions or typed.
  const [rivalSuggestions, setRivalSuggestions] = useState<CompetitorSuggestion[]>([]);
  const [rivalsLoading, setRivalsLoading] = useState(false);
  const [ownAuthority, setOwnAuthority] = useState<number | null>(null);
  const [rivalSizes, setRivalSizes] = useState<Record<string, RivalSize | null>>({});

  // Where the signup got to (lib/onboarding/step-events.ts). Fired and
  // forgotten; nothing on this screen waits for it.
  useEffect(() => {
    if (!running && !alreadyOnboarded) trackStep("wizard_opened", { workspaceId });
  }, [running, alreadyOnboarded, workspaceId]);
  useEffect(() => {
    if (!reading && profile && !running && !alreadyOnboarded) trackStep("profile_shown", { workspaceId });
  }, [reading, profile, running, alreadyOnboarded, workspaceId]);

  // Read the site. A failure is a normal outcome and is shown as one. Not
  // while a run is on screen: that page has already been through this.
  useEffect(() => {
    if (!reading || running || alreadyOnboarded) return;
    let cancelled = false;
    const readStarted = Date.now();
    trackStep("site_read_started", { workspaceId });
    proposeProfile(workspaceId)
      .then((r) => {
        trackStep(r.profile ? "site_read_finished" : "site_read_failed", { workspaceId, ms: Date.now() - readStarted });
        if (cancelled) return;
        setProfile(r.profile ?? EMPTY_PROFILE);
        if (r.profile) lookUpRivals(r.profile);
        setReadFailure(r.profile ? null : r.reason);
        // A billing refusal names this account's own state, so it travels as
        // a sentence rather than as a key into the copy map.
        setReadFailureMessage(r.profile ? null : r.message ?? null);
      })
      .catch(() => {
        trackStep("site_read_failed", { workspaceId, ms: Date.now() - readStarted });
        if (cancelled) return;
        setProfile(EMPTY_PROFILE);
        setReadFailure("model_failed");
        setReadFailureMessage(null);
      })
      .finally(() => !cancelled && setReading(false));
    return () => {
      cancelled = true;
    };
  }, [reading, running, workspaceId, alreadyOnboarded]);

  // Look for the sitemap and blog in the background while step 1 is on screen,
  // so step 3 opens with an answer rather than a spinner.
  useEffect(() => {
    if (discovery !== "pending" || running || alreadyOnboarded) return;
    let cancelled = false;
    discoverSiteDetails(workspaceId)
      .then((d) => {
        if (cancelled) return;
        setDiscovery(d);
        setSite((s) => ({
          sitemapUrl: s.sitemapUrl || d.sitemapUrl || "",
          blogRootUrl: s.blogRootUrl || d.blogRootUrl || "",
          exampleArticleUrls: s.exampleArticleUrls.length ? s.exampleArticleUrls : d.exampleArticleUrls,
        }));
      })
      .catch(() => !cancelled && setDiscovery({ sitemapUrl: null, blogRootUrl: null, exampleArticleUrls: [], found: false }));
    return () => {
      cancelled = true;
    };
  }, [discovery, running, workspaceId, alreadyOnboarded]);

  function lookUpRivals(read: BusinessProfile) {
    setRivalsLoading(true);
    suggestCompetitors(workspaceId, read)
      .then((found) => {
        setOwnAuthority(found.own);
        setRivalSuggestions(found.suggestions);
        // The homepage's rivals are already chosen; their size is now known.
        // The vetted results-page rivals ride along on the profile so the
        // keyword pool reads the same market the person saw here.
        setRivalSizes((sizes) => ({ ...sizes, ...Object.fromEntries(found.suggestions.map((s) => [s.domain, s.size])) }));
        if (found.searchRivals.length) patch({ searchRivals: found.searchRivals });
      })
      .catch(() => setRivalSuggestions([]))
      .finally(() => setRivalsLoading(false));
  }

  function patch(next: Partial<BusinessProfile>) {
    setProfile((p) => (p ? { ...p, ...next } : p));
  }

  /**
   * The one button. Saves everything on the screen, marks the wizard done and
   * starts the run. Nothing is saved before this: the five-step version wrote
   * each screen on Continue, so a person who closed the tab on screen three had
   * two screens of half-checked answers on disk and a wizard that reopened on
   * screen one anyway.
   */
  function finish() {
    setError(null);
    // Required, not because the form says so: the competitors decide the
    // first plan (see lib/onboarding/competitor-suggestions.ts).
    if (profile && profile.competitors.length === 0) {
      setError("Name at least one competitor. It is where your first article comes from.");
      return;
    }
    if (profile) trackStep("competitor_step_done", { workspaceId, count: profile.competitors.length });
    trackStep("plan_clicked", { workspaceId });
    start(async () => {
      try {
        if (profile) await saveProfile(workspaceId, profile);
        await saveSiteDetails(workspaceId, site);
        await completeWizard(workspaceId);
        posthog.capture("onboarding_completed", { workspace_id: workspaceId });
        setRunning(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save this.");
      }
    });
  }

  // Sent here by the dashboard gate, with no run recent enough to resume.
  // There is nothing to show the progress of and nothing to set up again -
  // only the card stands between this account and the product.
  if (!running && alreadyOnboarded && trialEligible) {
    return (
      <TrialGateScreen
        canBuy={canBuy}
        onRetry={() => setRunning(true)}
        domain={domain}
        planned={gatePlan}
        held={gateHeld}
        report={gateReport}
        firstArticle={firstArticle}
        writing={firstArticleWriting}
        fullArticle={fullArticle}
        initialHtml={initialHtml}
        workspaceId={workspaceId}
        setup={preTrialSetup}
        run={initialRun}
        askAttribution={askAttribution}
        userEmail={userEmail}
        otherSites={otherSites}
      />
    );
  }

  if (running) {
    return (
      <RunScreen
        canBuy={canBuy}
        workspaceId={workspaceId}
        domain={domain}
        freeDrafts={freeDrafts}
        trialEligible={trialEligible}
        askAttribution={askAttribution}
        initialRun={resumed}
        firstArticle={firstArticle}
        firstArticleWriting={firstArticleWriting}
        fullArticle={fullArticle}
        initialHtml={initialHtml}
        preTrialSetup={preTrialSetup}
        userEmail={userEmail}
        otherSites={otherSites}
      />
    );
  }

  if (reading || !profile) return <ReadingSite domain={domain} />;

  // Which sections open. Fixed by field, not by a confidence the model reports
  // about itself: on the two live runs that decided this, it was confident
  // about Semrush as a rival of an open-source SEO tool and about a
  // description of AltoRank with no "open source" in it. Offerings and
  // competitors are always open, because both seed keyword research and both
  // are what it gets wrong most; the rest collapse to one line of their actual
  // content, so a wrong answer is still glanceable rather than hidden behind
  // a tick. The blog section opens itself when nothing was found.
  const looking = discovery === "pending";
  const siteFound = Boolean(site.sitemapUrl || site.blogRootUrl || site.exampleArticleUrls.length);
  const businessLine = [profile.name, firstSentence(profile.description)].filter(Boolean).join(" · ");
  const audienceLine = profile.audiences.length ? profile.audiences.join(", ") : "None yet";
  const siteLine = looking
    ? `Looking for a sitemap and a blog on ${domain}…`
    : siteFound
      ? [
          site.sitemapUrl ? "Found the sitemap" : null,
          site.blogRootUrl ? "found the blog" : null,
          site.exampleArticleUrls.length ? `${site.exampleArticleUrls.length} example ${site.exampleArticleUrls.length === 1 ? "post" : "posts"}` : null,
        ].filter(Boolean).join(", ")
      : `Nothing found on ${domain}. Both are optional.`;

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[720px] px-6 pb-28 pt-10">
        <div className="mb-6 text-center">
          <h1 className="mb-1.5 text-[21px] font-semibold">Check what we found</h1>
          <p className="text-[13px] text-ink-2">
            {readFailure
              ? readFailure === "needs_plan"
                ? "This needs a plan."
                : `We could not fill this in from ${domain}.`
              : "Based on your website, we've filled this in. Two lists need your eye; the rest is a glance."}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Section
            title="About your business"
            line={businessLine || "Nothing read yet"}
            open={readFailure !== null || !profile.name}
            state={readFailure || !profile.name ? "attention" : "found"}
          >
            {readFailure && (
              <div className="mb-4 flex items-start justify-between gap-4 rounded-[8px] border border-line bg-bg p-4">
                <p className="m-0 text-[12.5px] leading-[1.6] text-ink-2">{readFailureMessage ?? FAILURE_COPY[readFailure]}</p>
                {readFailure !== "no_model" && readFailure !== "needs_plan" && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setReadFailure(null);
                      setReadFailureMessage(null);
                      setReading(true);
                    }}
                  >
                    Try again
                  </Button>
                )}
              </div>
            )}
            <BusinessFields profile={profile} patch={patch} />
          </Section>

          {/* The two that cost money when wrong. Always open, no tick. */}
          <div className="rounded-[10px] border border-accent/40 bg-panel p-5">
            <OfferingList profile={profile} patch={patch} />
          </div>
          <div className="rounded-[10px] border border-accent/40 bg-panel p-5">
            <CompetitorStep
              chosen={profile.competitors}
              sizes={rivalSizes}
              suggestions={rivalSuggestions}
              loading={rivalsLoading}
              onChange={(competitors, sizes) => {
                setRivalSizes(sizes);
                patch({ competitors });
                if (competitors.length) trackStep("competitor_step_done", { workspaceId, count: competitors.length });
              }}
              resolve={(entry) => resolveCompetitor(workspaceId, entry, ownAuthority)}
            />
          </div>

          {/* Empty is not found. An audience list the model returned nothing
              for opens, and says so, rather than sitting closed under a tick. */}
          <Section
            title="Target audiences"
            line={audienceLine}
            open={profile.audiences.length === 0}
            state={profile.audiences.length ? "found" : "attention"}
          >
            <AudienceList profile={profile} patch={patch} heading={false} />
          </Section>

          <Section
            title="Where your content lives"
            line={siteLine}
            open={!looking && !siteFound}
            state={looking ? "looking" : siteFound ? "found" : "attention"}
          >
            <div className="flex flex-col gap-4">
              <SiteFields site={site} setSite={setSite} domain={domain} />
              <div className="flex items-center justify-between rounded-[8px] border border-line bg-bg px-4 py-3">
                <div>
                  <div className="text-[13px] font-medium">Connect Search Console</div>
                  <div className="text-[12px] text-ink-3">So we skip keywords you already rank for, and can show real clicks later.</div>
                </div>
                {/* New tab: this screen's answers are not saved until the button below. */}
                <a href="/connect/google" target="_blank" rel="noreferrer">
                  <Button size="sm">Connect</Button>
                </a>
              </div>
            </div>
          </Section>
        </div>

        {error && <p className="mt-4 rounded-lg bg-err-soft px-3 py-2 text-[12.5px] text-err-ink">{error}</p>}
      </div>

      {/* Fixed, so the button is never a scroll away. One button: there is no
          Back because there is nowhere to go back to, and no Skip because
          nothing left on this screen is worth skipping - the settings that
          were live in Settings with the defaults we would have picked. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-4 px-6 py-3">
          <p className="m-0 text-[12.5px] leading-[1.5] text-ink-2">
            Next: keywords, a 30-day plan, and the first article written while you watch.
            {freeAllowanceClause(freeDrafts, { preTrial: trialEligible }) ? ` ${freeAllowanceClause(freeDrafts, { preTrial: trialEligible })}` : ""}
          </p>
          <Button variant="accent" onClick={finish} disabled={pending || reading}>
            {pending ? "Saving…" : "Plan my first articles"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The first sentence of a description, for the collapsed line. */
function firstSentence(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).slice(0, 140);
}

/**
 * A collapsible section whose closed state still shows what is inside it.
 *
 * `<details>`, so the browser owns the toggle and a person can open anything.
 * The summary carries the section's actual content on one line, not a
 * checkbox: "ready" is a claim, and the collapsed sections are the ones the
 * model is trusted on - which is exactly where a confident wrong answer would
 * hide behind a tick.
 */
function Section({
  title,
  line,
  open,
  state,
  children,
}: {
  title: string;
  line: string;
  open: boolean;
  state: "found" | "looking" | "attention";
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group rounded-[10px] border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h2 className="m-0 text-[13.5px] font-medium text-ink">{title}</h2>
          <p className="m-0 mt-0.5 truncate text-[12.5px] text-ink-2 group-open:hidden">{line}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          {state === "found" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-ok-ink">
              <Icons.check size={10} /> Found
            </span>
          )}
          {state === "looking" && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-ink-3">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Looking
            </span>
          )}
          {state === "attention" && (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn-ink">Needs a look</span>
          )}
          <span className="text-ink-3 transition-transform group-open:rotate-180">
            <Icons.caretDown size={12} />
          </span>
        </div>
      </summary>
      <div className="border-t border-line px-5 py-5">{children}</div>
    </details>
  );
}

/** The wait, with the work named. */
function ReadingSite({ domain }: { domain: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-[560px] text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink-2">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Reading {domain}…
        </div>
        <h1 className="mb-2 text-[22px] font-semibold">Setting up your site</h1>
        <p className="mx-auto max-w-[420px] text-[13.5px] leading-[1.6] text-ink-2">
          We read your homepage, and your blog if the homepage is thin, to fill in what we can. The next
          screen is a check rather than a form. About a minute.
        </p>
      </div>
    </div>
  );
}

const FAILURE_COPY: Record<InferenceReason, string> = {
  ok: "",
  no_model: "No model is configured on this install, so nothing could be proposed. Fill this in by hand.",
  unreadable:
    "We could not read enough of this site to describe it. That usually means the page is built with JavaScript, or it blocks crawlers. Fill this in by hand, or try again.",
  model_failed: "The site was read but the proposal failed. Try again, or fill this in by hand.",
  // Never rendered: `needs_plan` always carries its own sentence, because the
  // reason depends on the account (out of free drafts, paused, card declined).
  needs_plan: "",
};

/** "Sep 7" from a YYYY-MM-DD, in UTC so the day the planner wrote is the day shown. */
function calendarDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A site in another account the person can open instead of this card. */
export type OtherSite = { id: string; label: string };

/** Same term, as the plan and the article spell it. */
function sameTerm(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The way out, on a screen that is otherwise only a way forward. The gate has
 * no "continue to the dashboard", so it must not be a room with one door:
 * signing out is always here.
 */
function SignOutLine({ email, otherSites = [] }: { email?: string; otherSites?: OtherSite[] }) {
  return (
    <>
    {otherSites.length > 0 && (
      <p className="m-0 mt-8 text-center text-[12px] text-ink-3">
        You also work on{" "}
        {otherSites.map((site, i) => (
          <span key={site.id}>
            {i > 0 ? ", " : null}
            <button
              type="button"
              className="text-ink-2 underline decoration-line underline-offset-[3px]"
              onClick={() => {
                // The same cookie the dashboard's switcher writes; the
                // dashboard then scopes to that site and its account.
                document.cookie = `active_workspace=${site.id};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
                window.location.assign("/dashboard");
              }}
            >
              {site.label}
            </button>
          </span>
        ))}
        .
      </p>
    )}
    <p className={`m-0 ${otherSites.length > 0 ? "mt-2" : "mt-8"} text-center text-[12px] text-ink-3`}>
      {email ? <>Signed in as {email}. </> : null}
      <button
        type="button"
        className="text-ink-2 underline decoration-line underline-offset-[3px]"
        onClick={() => {
          posthog.reset();
          void signOut();
        }}
      >
        Sign out
      </button>
    </p>
    </>
  );
}

/**
 * An account whose one pre-trial article was attempted and failed after its
 * research was bought. The attempt is what the hold counts, so setup cannot
 * run again and nothing more is drafted before the trial; the honest screen
 * says the failure was ours and what the trial does about it.
 */
const FIRST_ARTICLE_FAILED_HEADING = "Your first article did not finish";
const FIRST_ARTICLE_FAILED_LEDE =
  `Setup started writing it and it failed on our side. It is written again once your ${TRIAL_DAYS}-day trial starts, along with the rest of this week's plan.`;

/**
 * The heading and lede for an ending, before the trial. An article's own
 * words follow it being written (first-look-gate.tsx `articleHeading`), so
 * "article" here is only the fallback for a page that has not read it yet.
 */
function endingWords(
  ending: SetupEnding,
  ctx: { domain: string; runState: Pick<OnboardingState, "steps" | "emptyPool"> | null; followUp: boolean },
): { heading: string; lede: string } {
  const draftingDetail = ctx.runState?.steps.find((s) => s.phase === "drafting")?.detail ?? null;
  switch (ending) {
    case "article":
      return { heading: "Your first article", lede: `Start your ${TRIAL_DAYS}-day trial to read it in full, approve it and publish it.` };
    case "writing":
      return { heading: "Your first article is being written", lede: "It appears here when it is done, usually within a few minutes. The trial opens it, and the rest of the week." };
    case "retry":
      return { heading: "Setup did not finish", lede: `Nothing was written for ${ctx.domain || "your site"}. Running setup again reads the site, plans the month and writes the first article.` };
    case "first-failed":
      return { heading: FIRST_ARTICLE_FAILED_HEADING, lede: FIRST_ARTICLE_FAILED_LEDE };
    case "nothing-planned":
      return { heading: NOTHING_PLANNED_HEADING, lede: nothingPlannedLede(ctx.domain, ctx.runState?.emptyPool ?? null, ctx.followUp) };
    case "no-article":
      return {
        heading: "No article was written in setup",
        lede: `${draftingDetail ? `Setup said: ${draftingDetail}` : "Setup finished without writing an article."} The trial opens the calendar, where articles can be written from the plan.`,
      };
  }
}

/** The page the gate sits on: one column, with room at the bottom for the slim ask bar. */
function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[680px] px-4 pb-28 pt-8 sm:px-6 sm:pt-10">{children}</div>
    </div>
  );
}

function RetryBox({ line, label, onRetry }: { line: string; label: string; onRetry: () => void }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel p-4">
      <p className="m-0 mb-3 text-sm">{line}</p>
      <Button variant="accent" onClick={onRetry}>
        {label}
      </Button>
    </div>
  );
}

/** The month behind the first article, as rows: the first ticked and named, the rest locked. */
function PlanRows({ planned, firstArticle, written }: { planned: OnboardingPlanned[]; firstArticle: FirstArticleCard | null; written: boolean }) {
  return (
    <ul className="m-0 list-none divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-bg p-0">
      {planned.slice(0, 8).map((p) => {
        const done = firstArticle && sameTerm(firstArticle.keyword, p.term) ? firstArticle : null;
        return (
          <li key={`${p.date}-${p.term}`} className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px] ${done ? "" : "opacity-55"}`}>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="shrink-0 text-ok-ink">{done ? <Icons.check size={13} /> : <Icons.lock size={12} />}</span>
              <span className="min-w-0">
                <span className="block break-words text-ink">{done ? done.title || p.term : p.term}</span>
                {done && (
                  <span className="block text-[11.5px] text-ink-3">
                    {written ? `Written${done.wordCount > 0 && done.state === "written" ? ` · ${done.wordCount.toLocaleString("en-US")} words` : ""}` : "Being written"} · opens with the trial
                  </span>
                )}
              </span>
            </div>
            <span className="shrink-0 font-mono text-[11px] text-ink-3">{calendarDay(p.date)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The card, for an account that is already set up.
 *
 * What somebody sees on their second visit, or their thirtieth, and what every
 * dashboard link sends an account that has not started its trial to. The same
 * gate as the end of the run (first-look-gate.tsx): the article, the ask
 * under it, why this article; the plan and the site report folded below.
 * There is no way into the dashboard: the trial is the way forward, and
 * signing out the way out.
 *
 * "Has a first article" is the workspace's fact, not the latest run's. When a
 * later visit read it off the run, the screen said the draft was not ready
 * beside an email that said it was, and its retry paid for a whole second
 * setup to replace an article that existed (lib/onboarding/setup-retry.ts).
 */
function TrialGateScreen({
  domain,
  canBuy,
  onRetry,
  planned,
  held = null,
  report,
  firstArticle,
  writing,
  fullArticle = false,
  initialHtml = null,
  workspaceId,
  setup,
  run,
  askAttribution = false,
  userEmail,
  otherSites = [],
}: {
  domain: string;
  canBuy: boolean;
  fullArticle?: boolean;
  initialHtml?: string | null;
  workspaceId: string;
  onRetry: () => void;
  planned: OnboardingPlanned[];
  held?: OnboardingHeld | null;
  report: FirstLookReport | null;
  firstArticle: FirstArticleCard | null;
  writing: boolean;
  setup: PreTrialSetup;
  run: OnboardingRunSnapshot | null;
  askAttribution?: boolean;
  userEmail?: string;
  otherSites?: OtherSite[];
}) {
  const runState = runStateOf(run);
  // One decision for the heading, the lede and whether the card is asked
  // (lib/onboarding/setup-retry.ts); the run screen reads the same one.
  const ending = setupEnding(runState, {
    hasArticle: firstArticle !== null,
    writing,
    setupAllowed: setup.setupAllowed,
    firstAttempted: setup.firstAttempted,
  });
  const words = endingWords(ending, { domain, runState, followUp: setup.followUp });
  const fixable = report?.readiness?.findings.filter((f) => !f.passed && !f.inconclusive).length ?? 0;
  const pagesToFix = report?.existingPages?.withIssues ?? 0;
  const written = firstArticle?.state === "written";

  return (
    <GateShell>
      <GateTop
        workspaceId={workspaceId}
        canBuy={canBuy}
        ending={ending}
        followUp={setup.followUp}
        heading={words.heading}
        lede={words.lede}
        retry={
          ending === "retry" ? (
            <RetryBox
              line={runState ? "The last setup run stopped before it wrote an article." : "Setup was skipped, so no article has been written yet."}
              label={runState ? "Run setup again" : "Write my first article"}
              onRetry={onRetry}
            />
          ) : null
        }
        firstArticle={firstArticle}
        planned={planned}
        fullArticle={fullArticle}
        initialHtml={initialHtml}
      />

      <div className="mt-6 flex flex-col gap-2">
        {planned.length > 0 && (
          <Fold
            title="Your plan"
            line={`${planned.length} ${planned.length === 1 ? "article" : "articles"} scheduled${held && held.count > 0 ? `, ${held.count} more ready for your trial` : ""}`}
          >
            <PlanRows planned={planned} firstArticle={firstArticle} written={written} />
            <p className="m-0 text-[12px] text-ink-2">
              {firstArticle ? "The rest are scheduled. They start writing when your trial does." : "These start writing when your trial does."}
            </p>
          </Fold>
        )}
        {report && (
          <Fold
            title="Your site report"
            line={[
              fixable > 0 ? `${fixable} ${fixable === 1 ? "thing" : "things"} stopping AI assistants reading ${domain || "your site"}` : null,
              pagesToFix > 0 ? `${pagesToFix} existing ${pagesToFix === 1 ? "page" : "pages"} with something to fix` : null,
            ].filter(Boolean).join(" · ") || `${domain || "Your site"}, as we read it`}
          >
            <FirstLookReportView report={report} domain={domain} live={false} />
          </Fold>
        )}
      </div>
      {askAttribution && (
        <div className="mt-6">
          <AttributionAsk />
        </div>
      )}
      <SignOutLine email={userEmail} otherSites={otherSites} />
    </GateShell>
  );
}

/**
 * The finish: the pipeline, live, then - for an account before its trial -
 * the gate.
 *
 * For an account before its trial the run ends on the card and never on a
 * button into the dashboard: the dashboard is what the trial opens, and a
 * "Finish" that led there only bounced back here. Its wait is one calm
 * screen (./setup-loading.tsx), and its end is the gate (./first-look-gate.tsx),
 * in one tree: the run's poller is mounted once and is never remounted
 * between the two, which would start a run again.
 *
 * Everyone else - self-host, operators, a paying account - sees the run as a
 * log and a calendar, and a button to the plan at the end.
 */
function RunScreen({
  workspaceId,
  canBuy,
  domain,
  freeDrafts,
  trialEligible,
  askAttribution = false,
  initialRun,
  firstArticle,
  firstArticleWriting,
  fullArticle = false,
  initialHtml = null,
  preTrialSetup,
  userEmail,
  otherSites = [],
}: {
  fullArticle?: boolean;
  initialHtml?: string | null;
  workspaceId: string;
  canBuy: boolean;
  domain: string;
  freeDrafts: number | null;
  trialEligible: boolean;
  askAttribution?: boolean;
  initialRun: OnboardingRunSnapshot | null;
  firstArticle: FirstArticleCard | null;
  firstArticleWriting: boolean;
  preTrialSetup: PreTrialSetup;
  userEmail?: string;
  otherSites?: OtherSite[];
}) {
  const router = useRouter();
  // Read from the run the page found, so a reload of a finished run opens on
  // the gate and not, for one frame, on the loading screen.
  const [state, setState] = useState<OnboardingState | null>(() =>
    initialRun?.run ? stateFromRun(initialRun.run, initialRun.article, { stale: initialRun.stale, drafts: initialRun.drafts, held: initialRun.held }) : null,
  );
  // Bumped by "Try again". `OnboardingProgress` starts a run on mount and
  // never again, so a retry is a remount with no run to resume: the mount
  // effect POSTs /start, which creates a fresh row (the last one is finished)
  // and polls it. Nothing on the old attempt is touched - its phases are on
  // their own tables and its row keeps its status.
  const [attempt, setAttempt] = useState(0);
  // Bumped when the first article's body lands after the gate, so the run's
  // log is read again and says what was written.
  const [bodyLanded, setBodyLanded] = useState(0);
  const finished = Boolean(state && (state.ready || state.error));
  const planned = state?.planned ?? [];
  // Where "Finish" actually leads, decided by what the run produced. It used
  // to read "Open my plan" and push /content on any terminal state, so a run
  // that scheduled nothing offered a button to an empty calendar.
  const outcome = state ? onboardingOutcome(state) : null;
  const draft = state?.article ?? null;
  const drafts = state?.drafts ?? [];
  // The run's own record of the first draft, for the moment between the run
  // writing it and the page reading its card. The card is the page's read of
  // the workspace (lib/onboarding/first-article.ts); this only fills the gap.
  const runDraft = draft ?? drafts[0] ?? null;
  const hasArticle = firstArticle !== null || runDraft !== null;
  // The last step of onboarding, for an account before its trial: the card,
  // whatever the run produced. With an article it shows the article; without
  // one it offers a retry only when the run fell short and nothing exists
  // for the site (lib/onboarding/setup-retry.ts).
  const trialStep = finished && trialEligible;
  // The same decision the gate screen makes (lib/onboarding/setup-retry.ts):
  // whether to ask for the card at all, and what to say instead when the run
  // planned nothing.
  const ending: SetupEnding | null =
    trialStep && state !== null
      ? setupEnding(state, {
          hasArticle,
          writing: firstArticleWriting,
          setupAllowed: preTrialSetup.setupAllowed,
          firstAttempted: preTrialSetup.firstAttempted,
        })
      : null;
  // The run ended after this page was read: read it again. With a draft, so
  // the card has its outline and sources; without one, so the retry and the
  // copy answer from the spend gate and the claim as they are NOW - read
  // before the run, they said setup could run again after the run had used
  // the account's one article. Once per finished run.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!trialStep || firstArticle || refreshed.current) return;
    refreshed.current = true;
    router.refresh();
  }, [trialStep, firstArticle, router]);
  const retryRun = () => {
    setState(null);
    setAttempt((a) => a + 1);
  };

  if (trialEligible) {
    const words = ending ? endingWords(ending, { domain, runState: state, followUp: preTrialSetup.followUp }) : null;
    const held = state?.held ?? null;
    const scheduled = planned.length > 0 ? (
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Scheduled</div>
        <ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2">
          {planned.slice(0, 10).map((p) => (
            <li key={p.date + p.term} className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
              <span className="shrink-0 font-mono text-[11px] text-ink-3">{p.date.slice(5)}</span>
              <span className="min-w-0 break-words">{p.term}</span>
            </li>
          ))}
          {held && held.count > 0 && held.dates.slice(0, 10).map((date, i) => (
            <li key={`held-${date}-${i}`} className="flex items-baseline gap-2 text-[12.5px] text-ink-3">
              <span className="shrink-0 font-mono text-[11px]">{date.slice(5)}</span>
              <span>Ready · opens with the trial</span>
            </li>
          ))}
        </ul>
        {planned.length > 10 && <p className="m-0 mt-1.5 text-[12px] text-ink-3">and {planned.length - 10} more on the calendar.</p>}
      </div>
    ) : null;
    return (
      <GateShell>
        {trialStep && ending && words ? (
          <GateTop
            workspaceId={workspaceId}
            canBuy={canBuy}
            ending={ending}
            followUp={preTrialSetup.followUp}
            heading={words.heading}
            lede={words.lede}
            retry={ending === "retry" ? <RetryBox line="Setup stopped before it wrote your first article." label="Run setup again" onRetry={retryRun} /> : null}
            firstArticle={firstArticle}
            pending={runDraft ? { title: runDraft.title, keyword: runDraft.keyword, wordCount: runDraft.wordCount, outlined: runDraft.outlined === true } : null}
            planned={planned}
            fullArticle={fullArticle}
            initialHtml={initialHtml}
            onBodyDone={() => setBodyLanded((n) => n + 1)}
          />
        ) : null}
        <div className={trialStep ? "mt-6" : undefined}>
          <OnboardingProgress
            key={attempt}
            workspaceId={workspaceId}
            domain={domain}
            autoNavigate={false}
            onState={setState}
            initialRun={attempt === 0 ? initialRun : null}
            lockHeld
            preTrial
            variant="first-look"
            refreshKey={bodyLanded}
            scheduled={scheduled}
          />
        </div>
        {trialStep && askAttribution ? (
          <div className="mt-6">
            <AttributionAsk />
          </div>
        ) : null}
        {trialStep ? <SignOutLine email={userEmail} otherSites={otherSites} /> : null}
      </GateShell>
    );
  }

  const next = planned.length > 0
    ? { href: "/content", label: "Open my plan" }
    : draft
      ? { href: "/review", label: "Open my first draft" }
      : { href: "/dashboard", label: "Open the dashboard" };
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[860px] px-6 py-10">
        <div className="mb-8 text-center">
          <h1 className="mb-1.5 text-[22px] font-semibold">{finished ? "Your content plan" : "Creating your content plan"}</h1>
          <p className="mx-auto max-w-[520px] text-[13.5px] leading-[1.6] text-ink-2">
            Reading {domain}, checking buyer needs and live search results, preparing up to five specific article ideas, and writing
            the first one. Only topics with supporting evidence make the plan, so your site may get fewer.{" "}
            {freeAllowanceClause(freeDrafts === null ? null : Math.min(1, freeDrafts), { preTrial: false }) ?? ""}
            {/* True since the run left the browser's request: it is a row
                advanced by its own invocations (/api/onboard/run, then
                /api/internal/draft), and this screen only polls it. Gone once
                the run is over, because a screen that has said "Done." has no
                wait left to describe. */}
            {!finished && (
              <>
                {" "}
                You can leave this page and come back: the run carries on without you, and this screen picks up where it is.
              </>
            )}
          </p>
        </div>

        <div className="mx-auto max-w-[640px]">
          <div className="rounded-[10px] border border-line bg-panel p-5">
            <OnboardingProgress
              key={attempt}
              workspaceId={workspaceId}
              domain={domain}
              autoNavigate={false}
              onState={setState}
              initialRun={attempt === 0 ? initialRun : null}
            />
            {planned.length > 0 && (
              <div className="mt-5">
                <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Scheduled</div>
                <ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2">
                  {planned.slice(0, 10).map((p) => (
                    <li key={p.date + p.term} className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{p.date.slice(5)}</span>
                      <span className="truncate">{p.term}</span>
                    </li>
                  ))}
                </ul>
                {planned.length > 10 && <p className="m-0 mt-1.5 text-[12px] text-ink-3">and {planned.length - 10} more on the calendar.</p>}
              </div>
            )}
            <div className="mt-6 flex items-center gap-3">
              {/* A plain navigation, live or not: the run is its own
                  invocations now and nothing on this page can cancel it.
                  Coming back to /onboarding resumes the screen. */}
              {finished ? (
                <Button variant="accent" onClick={() => router.push(next.href)}>
                  {next.label}
                </Button>
              ) : (
                <>
                  <Button variant="accent" disabled={planned.length === 0} onClick={() => router.push("/content")}>
                    Open the calendar so far
                  </Button>
                  <span className="text-[12px] text-ink-3">Still working…</span>
                </>
              )}
            </div>
            {/* The run's own account of itself, when it fell short of the
                calendar the header just promised. `OnboardingProgress` prints
                the same sentence, so this only adds the part the button needs
                to be honest about. */}
            {outcome && (outcome.tone === "error" || (outcome.tone === "partial" && !outcome.produced)) && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[8px] border border-warn bg-warn-soft px-3 py-2.5">
                <p className="m-0 min-w-0 flex-1 text-[12px] leading-[1.55] text-warn-ink">
                  {/* A run that fell short is a thing to retry, right here,
                      not a job to hand the person. */}
                  Nothing was set up yet. Trying again is free to try; if the site still cannot be read,
                  add a keyword by hand from Keywords or connect Search Console and the plan can be built
                  from there.
                </p>
                <Button size="sm" onClick={retryRun}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
