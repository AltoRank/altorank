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

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import {
  proposeProfile,
  resolveCompetitor,
  suggestCompetitors,
  saveProfile,
  saveProfileDraft,
  discoverSiteDetails,
  saveSiteDetails,
  completeWizard,
} from "@/app/actions/onboarding-wizard";
import { mayStartSetupOver, stopSetupToChange } from "@/app/actions/onboarding-restart";
import { offerStopToChange, stoppableToChange } from "@/lib/onboarding/stop-to-change";
import type { SiteDetails } from "@/lib/onboarding/output-settings";
import type { OnboardingHeld } from "@/lib/onboarding/events";
import { EMPTY_PROFILE, type BusinessProfile } from "@/lib/onboarding/profile-shape";
import type { InferenceReason } from "@/lib/onboarding/business-profile";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
// The forms themselves live in components/settings: every wizard screen is
// also a permanent Settings tab, and one copy of each form keeps them in step.
import { BusinessFields, LANGUAGE_SELECT_ID } from "@/components/settings/business-fields";
import { AudienceList, OfferingList } from "@/components/settings/audience-fields";
import { CompetitorStep } from "@/components/onboarding/competitor-step";
import { trackStep } from "@/lib/onboarding/track-step";
import type { CompetitorSuggestion, RivalSize } from "@/lib/onboarding/competitor-suggestions";
import { SiteFields } from "@/components/settings/site-fields";
import { OnboardingProgress, reportLine } from "@/components/onboarding/onboarding-progress";
import {
  onboardingOutcome,
  shouldResumeRun,
  stateFromRun,
  type OnboardingPlanned,
  type OnboardingRunSnapshot,
  type OnboardingState,
} from "@/lib/onboarding/events";
import { freeAllowanceClause, wizardNextLine } from "@/lib/onboarding/copy";
import { businessLine, finishBlocker, localeLine, preTickRival, siteSummary, withPendingCompetitor } from "@/lib/onboarding/wizard-rules";
import { createDraftSaver } from "@/lib/onboarding/draft-saver";
import { FirstLookReportView } from "@/components/onboarding/first-look-report";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";
import { OPEN_SETUP, runStateOf, setupEnding, type PreTrialSetup, type SetupEnding } from "@/lib/onboarding/setup-retry";
import { NOTHING_PLANNED_HEADING, nothingPlannedLede } from "@/components/onboarding/setup-ask";
import { providerRetryWindowOpen } from "@/lib/onboarding/provider-retry-window";
import { GateTop, type GateWelcome } from "@/components/onboarding/first-look-gate";
import { nextArticles } from "@/lib/onboarding/next-articles";
import { WhatWeUnderstood } from "@/components/onboarding/what-we-understood";
import { Fold } from "@/components/onboarding/fold";
import { signOut } from "@/app/actions/auth";
import { TRIAL_DAYS } from "@/lib/stripe";
import type { TrialOfferFacts } from "@/lib/billing/trial-offer";
import posthog from "posthog-js";
import { EDITOR_FITS_QUERY, firstArticleReturn } from "@/lib/billing/checkout-return";

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
  welcome = null,
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
  offer,
  autoStart = false,
}: {
  /** The trial offer's facts, read on the server (lib/billing/trial-offer.ts). */
  offer: TrialOfferFacts;
  /**
   * Start the run as soon as the site read lands, with no check screen in
   * between: what the read found is shown beside the run instead
   * (./what-we-understood.tsx). The check form still opens when the read
   * failed or found nothing to write about, and from the panel's "Wrong? Fix
   * it and start over" while the run is still reading the site
   * (lib/onboarding/stop-to-change.ts). Decided on the server
   * (ONBOARDING_AUTOSTART).
   */
  autoStart?: boolean;
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
  /**
   * The gate opens on its return screen: a recorded visit 12 hours ago or
   * more (lib/onboarding/gate-visits.ts), or a checkout just cancelled.
   */
  welcome?: GateWelcome | null;
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
  // Language and market were guessed from the page's `lang` and its country
  // domain because the read failed: said beside them.
  const [localeGuessed, setLocaleGuessed] = useState(false);
  const [discovery, setDiscovery] = useState<SiteDiscovery | null | "pending">(initialSite.sitemapUrl || initialSite.blogRootUrl ? null : "pending");
  // A run found on load is resumed; otherwise Finish starts one.
  const [resumed] = useState(() => (initialRun && shouldResumeRun(initialRun, Date.now()) ? initialRun : null));
  const [running, setRunning] = useState(resumed !== null);
  // "Change what we found and try again": the wizard reopened over a setup
  // that planned nothing or fell short, with the saved profile, for the one
  // more run the spend gate allows before the trial (PRE_TRIAL_SETUP_RUNS).
  const [editing, setEditing] = useState(false);
  // Where "Change what we found" was opened from, for its way back: the gate
  // a returning account landed on, or the run screen of a run that just
  // ended (which is remounted only to start a run, so it is reloaded).
  const [editFrom, setEditFrom] = useState<"gate" | "run">("gate");
  // Each confirmed finish is a fresh run on screen: the run screen is
  // remounted with no run to resume, so it starts one (the spend gate decides).
  const [runKey, setRunKey] = useState(0);
  // What the profile was when "Change what we found" opened, restored on Back.
  const beforeEdit = useRef<{ profile: BusinessProfile | null; site: SiteDetails } | null>(null);
  const reopen = () => {
    beforeEdit.current = { profile, site };
    setEditFrom(running ? "run" : "gate");
    setRunning(false);
    setEditing(true);
    setBlocker(null);
    window.scrollTo({ top: 0 });
  };
  const [pending, start] = useTransition();
  // What stops the main button, shown in the bar beside it.
  const [blocker, setBlocker] = useState<string | null>(null);
  // The blocker on screen is the finish rule's, which an edit can satisfy.
  const ruleBlocked = useRef(false);
  /**
   * Back out of "Change what we found" without spending the free try: the
   * only control there used to be "Try again with these changes" (review,
   * 2026-10-12). Nothing typed here is kept: the profile is put back as it
   * was, and a confirmed profile is never overwritten by a draft.
   */
  const leaveEditing = () => {
    if (editFrom === "run") {
      window.location.assign("/onboarding");
      return;
    }
    if (beforeEdit.current) {
      setProfile(beforeEdit.current.profile);
      setSite(beforeEdit.current.site);
    }
    ruleBlocked.current = false;
    setBlocker(null);
    setEditing(false);
    window.scrollTo({ top: 0 });
  };
  // Rivals proposed for the competitor step, looked up once the profile is
  // read (the lookup starts from the profile's offerings), and the size of
  // every host the person has chosen, from suggestions or typed.
  const [rivalSuggestions, setRivalSuggestions] = useState<CompetitorSuggestion[]>([]);
  const [rivalsLoading, setRivalsLoading] = useState(false);
  const [rivalLookupFailed, setRivalLookupFailed] = useState(false);
  const [ownAuthority, setOwnAuthority] = useState<number | null>(null);
  const [rivalSizes, setRivalSizes] = useState<Record<string, RivalSize | null>>({});
  // Typed into the competitor box and not added: kept by the final click.
  const competitorDraft = useRef("");

  // Saved as the owner edits (lib/onboarding/draft-saver.ts), so a person
  // who leaves comes back to what they had checked. Only the owner's own
  // edits start it: a profile nobody has touched is the site read again,
  // and saving that would only stop the next visit from reading it.
  const edited = useRef(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [drafts] = useState(() =>
    createDraftSaver(({ p, s }: { p: BusinessProfile; s: SiteDetails }) =>
      saveProfileDraft(workspaceId, p, s).then((r) => setDraftSaved(r.ok)),
    ),
  );
  useEffect(() => {
    if (edited.current && profile && !running && !alreadyOnboarded) drafts.push({ p: profile, s: site });
  }, [profile, site, running, alreadyOnboarded, drafts]);
  // A tab sent to the background may never come back: save what is pending.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") void drafts.flush();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [drafts]);

  // Where the signup got to (lib/onboarding/step-events.ts). Fired and
  // forgotten; nothing on this screen waits for it.
  useEffect(() => {
    if (!running && !alreadyOnboarded) trackStep("wizard_opened", { workspaceId });
  }, [running, alreadyOnboarded, workspaceId]);
  useEffect(() => {
    if (!reading && profile && !running && !alreadyOnboarded) trackStep("profile_shown", { workspaceId });
  }, [reading, profile, running, alreadyOnboarded, workspaceId]);

  function lookUpRivals(read: BusinessProfile) {
    setRivalsLoading(true);
    setRivalLookupFailed(false);
    suggestCompetitors(workspaceId, read)
      .then((found) => {
        setOwnAuthority(found.own);
        setRivalSuggestions(found.suggestions);
        // The sources answer empty on a provider outage rather than throw,
        // so the lookup says whether it could look at all.
        setRivalLookupFailed(found.lookupFailed === true);
        // The homepage's rivals are already chosen; their size is now known.
        // The vetted results-page rivals ride along on the profile so the
        // keyword pool reads the same market the person saw here. With none
        // chosen, the best suggestion is ticked for them: competitors are
        // optional, and one the owner can untick beats an empty box.
        setRivalSizes((sizes) => ({ ...sizes, ...Object.fromEntries(found.suggestions.map((s) => [s.domain, s.size])) }));
        setProfile((p) => {
          if (!p) return p;
          const pick = preTickRival(p.competitors, found.suggestions);
          return {
            ...p,
            ...(found.searchRivals.length ? { searchRivals: found.searchRivals } : {}),
            ...(pick ? { competitors: [pick.domain] } : {}),
          };
        });
      })
      .catch(() => {
        setRivalSuggestions([]);
        setRivalLookupFailed(true);
      })
      .finally(() => setRivalsLoading(false));
  }

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
        // A failed read starts from what the site gives away - its page
        // language and country domain - not from English / Global.
        setProfile(r.profile ?? { ...EMPTY_PROFILE, ...(r.localeGuess ?? {}) });
        setLocaleGuessed(!r.profile && Boolean(r.localeGuess));
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
        setLocaleGuessed(false);
        setReadFailure("model_failed");
        setReadFailureMessage(null);
      })
      .finally(() => !cancelled && setReading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lookUpRivals is a plain function; the read runs once per press
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

  // The fixed bar's real height, so the last section is never under it and
  // a field reached by Tab is scrolled clear of it (WCAG 2.4.11).
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState<number | null>(null);
  const wizardShown = !running && !(alreadyOnboarded && trialEligible && !editing) && !reading && profile !== null;
  useEffect(() => {
    const bar = barRef.current;
    if (!wizardShown || !bar || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const h = Math.ceil(bar.getBoundingClientRect().height);
      setBarHeight(h);
      root.style.scrollPaddingBottom = `${h + 16}px`;
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.scrollPaddingBottom = "";
    };
  }, [wizardShown]);

  // The rule's blocker clears as soon as the edit satisfies it: the alert
  // stayed beside the button after the offering was added, and kept the
  // bar's promise line hidden until another click (review, 2026-10-12). A
  // save that failed keeps its message until the next click.
  useEffect(() => {
    if (!ruleBlocked.current || !profile) return;
    if (finishBlocker(withPendingCompetitor(profile, competitorDraft.current))) return;
    ruleBlocked.current = false;
    setBlocker(null);
  }, [profile]);

  /** An edit the owner made, which is what starts the draft save. */
  function patch(next: Partial<BusinessProfile>) {
    edited.current = true;
    setProfile((p) => (p ? { ...p, ...next } : p));
  }
  function editSite(next: SiteDetails) {
    edited.current = true;
    setSite(next);
  }

  /** Say what stops the button beside it, and take the person to the field. */
  function block(message: string, fieldId?: string) {
    setBlocker(message);
    if (!fieldId) return;
    const field = document.getElementById(fieldId);
    if (!field) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    field.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    field.focus({ preventScroll: true });
  }

  /**
   * The one button. Saves everything on the screen as confirmed, marks the
   * wizard done and starts the run. The drafts saved while editing carry no
   * confirmation; this click is it. `auto` is the run starting by itself
   * with nobody having read the screen, so it saves without one.
   */
  function finish({ auto = false }: { auto?: boolean } = {}) {
    if (!profile) return;
    const confirmed = withPendingCompetitor(profile, competitorDraft.current);
    const stop = finishBlocker(confirmed);
    if (stop) {
      block(stop.message, OFFERINGS_INPUT_ID);
      ruleBlocked.current = true;
      return;
    }
    ruleBlocked.current = false;
    setBlocker(null);
    trackStep("competitor_step_done", { workspaceId, count: confirmed.competitors.length + (confirmed.competitorNames?.length ?? 0) });
    trackStep(auto ? "plan_auto" : "plan_clicked", { workspaceId });
    start(async () => {
      try {
        // No draft may land after the confirmed save.
        await drafts.stop();
        await saveProfile(workspaceId, confirmed, { auto });
        await saveSiteDetails(workspaceId, site);
        await completeWizard(workspaceId);
        posthog.capture("onboarding_completed", { workspace_id: workspaceId });
        setEditing(false);
        setRunKey((k) => k + 1);
        setRunning(true);
      } catch (e) {
        drafts.resume();
        block(e instanceof Error ? e.message : "Could not save this. Try again.");
      }
    });
  }

  // The run starts by itself once everything the check screen would have
  // shown has landed: the profile, the rivals proposed from it, and the
  // sitemap and blog. Once per visit; a refusal (nothing to write about, a
  // save that failed) leaves the form on screen with its reason.
  const [autoTried, setAutoTried] = useState(false);
  const autoEligible = autoStart && !alreadyOnboarded && !editing && !running;
  const autoReady = autoEligible && !autoTried && !reading && profile !== null && readFailure === null && !rivalsLoading && discovery !== "pending";
  useEffect(() => {
    if (!autoReady || !profile) return;
    const blocked = finishBlocker(withPendingCompetitor(profile, competitorDraft.current)) !== null;
    // After this render, and only for the effect that is still current: in
    // development React mounts effects twice, and two finishes would be two
    // saves racing to start the run.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setAutoTried(true);
      if (!blocked) finish({ auto: true });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finish and profile are read once, when the read has landed
  }, [autoReady]);
  // Until then the reading screen stays up, so the form never flashes on
  // the way to the run.
  const autoWaiting = autoEligible && readFailure === null && (!autoTried || pending);

  // Sent here by the dashboard gate, with no run recent enough to resume.
  // There is nothing to show the progress of and nothing to set up again -
  // only the card stands between this account and the product.
  if (!running && alreadyOnboarded && trialEligible && !editing) {
    return (
      <TrialGateScreen
        onEdit={preTrialSetup.setupAllowed ? reopen : undefined}
        canBuy={canBuy}
        onRetry={() => {
          setRunKey((k) => k + 1);
          setRunning(true);
        }}
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
        welcome={welcome}
        userEmail={userEmail}
        otherSites={otherSites}
        offer={offer}
      />
    );
  }

  if (running) {
    return (
      <RunScreen
        key={runKey}
        onEdit={preTrialSetup.setupAllowed ? reopen : undefined}
        canBuy={canBuy}
        workspaceId={workspaceId}
        domain={domain}
        freeDrafts={freeDrafts}
        trialEligible={trialEligible}
        initialRun={runKey === 0 ? resumed : null}
        firstArticle={firstArticle}
        firstArticleWriting={firstArticleWriting}
        fullArticle={fullArticle}
        initialHtml={initialHtml}
        preTrialSetup={preTrialSetup}
        userEmail={userEmail}
        otherSites={otherSites}
        offer={offer}
        profile={profile}
      />
    );
  }

  if (reading || !profile || autoWaiting) return <ReadingSite domain={domain} autoStart={autoEligible} />;

  // Which sections open, decided once, when the screen first shows: a
  // section never opens or closes itself from what is being typed (the first
  // character of a sitemap URL used to snap its section shut and drop focus
  // to the page). Fixed by field, not by a confidence the model reports
  // about itself: on the two live runs that decided this, it was confident
  // about Semrush as a rival of an open-source SEO tool and about a
  // description of AltoRank with no "open source" in it. Offerings and
  // competitors are always open, because both seed keyword research and both
  // are what it gets wrong most; the rest collapse to one line of their actual
  // content, so a wrong answer is still glanceable rather than hidden behind
  // a tick. "Where your content lives" is optional and stays closed.
  // Reopened over a finished setup, the site is not looked at again.
  const looking = discovery === "pending" && !alreadyOnboarded;
  const siteLine = siteSummary(site, looking, domain);
  const audienceLine = profile.audiences.length ? profile.audiences.join(", ") : "None yet";
  const next = editing
    ? { full: "We read your site again with what you changed and look for a first article, in about 3 minutes. Nothing is charged.", short: "One more free try, about 3 minutes." }
    : wizardNextLine({ preTrial: trialEligible, canRead: fullArticle, freeDrafts });

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[720px] px-4 pt-10 sm:px-6" style={{ paddingBottom: (barHeight ?? 112) + 24 }}>
        <div className="mb-6 text-center">
          <h1 className="mb-1.5 text-[21px] font-semibold">{editing ? "Change what we found" : "Check what we found"}</h1>
          <p className="text-[13px] text-ink-2 [text-wrap:balance]">
            {editing
              ? `Correct what we got wrong about ${domain || "your site"} - what you sell, who buys it, who you compete with - then try again. You get one more free try before the trial.`
              : readFailure
              ? readFailure === "needs_plan"
                ? "This needs a plan."
                : `We could not fill this in from ${domain}.`
              : initialProfile
                ? `Here is what we have for ${domain}. Check the two lists below; the rest only needs a glance.`
                : "Based on your website, we've filled this in. Check the two lists below; the rest only needs a glance."}
          </p>
          <p aria-live="polite" className="m-0 mt-1 min-h-[1.25rem] text-[11.5px] text-ink-3">
            {draftSaved ? "Your answers are saved as you go." : ""}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Section
            title="About your business"
            line={businessLine(profile) || "Nothing read yet"}
            initialOpen={readFailure !== null || !profile.name}
            state={readFailure || !profile.name ? "attention" : "found"}
            footer={(open) => (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-ink-2">
                <span className="text-ink-3">Language and market:</span>
                <span className="font-medium text-ink">{localeLine(profile)}</span>
                {localeGuessed && <span className="text-ink-3">(guessed from your site)</span>}
                <button
                  type="button"
                  className="rounded-md px-1 text-accent-ink underline decoration-line underline-offset-[3px] hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  onClick={() => {
                    open();
                    requestAnimationFrame(() => document.getElementById(LANGUAGE_SELECT_ID)?.focus());
                  }}
                >
                  Change
                </button>
              </div>
            )}
          >
            {readFailure && (
              <div className="mb-4 flex flex-col items-start gap-3 rounded-[8px] border border-line bg-bg p-4 sm:flex-row sm:justify-between sm:gap-4">
                <p className="m-0 text-[12.5px] leading-[1.6] text-ink-2">{readFailureMessage ?? FAILURE_COPY[readFailure]}</p>
                {readFailure !== "no_model" && readFailure !== "needs_plan" && readFailure !== "limited" && (
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
          <div className="rounded-[10px] border border-accent/40 bg-panel p-4 sm:p-5">
            <OfferingList profile={profile} patch={patch} inputId={OFFERINGS_INPUT_ID} />
          </div>
          <div className="rounded-[10px] border border-accent/40 bg-panel p-4 sm:p-5">
            <CompetitorStep
              chosen={profile.competitors}
              names={profile.competitorNames ?? []}
              sizes={rivalSizes}
              suggestions={rivalSuggestions}
              loading={rivalsLoading}
              lookupFailed={rivalLookupFailed}
              onChange={({ competitors, names, sizes }) => {
                setRivalSizes(sizes);
                patch({ competitors, competitorNames: names });
                if (competitors.length + names.length) trackStep("competitor_step_done", { workspaceId, count: competitors.length + names.length });
              }}
              onDraft={(text) => {
                competitorDraft.current = text;
              }}
              resolve={(entry) => resolveCompetitor(workspaceId, entry, ownAuthority)}
            />
          </div>

          {/* Empty is not found. An audience list the model returned nothing
              for opens, and says so, rather than sitting closed under a tick. */}
          <Section
            title="Target audiences"
            line={audienceLine}
            initialOpen={profile.audiences.length === 0}
            state={profile.audiences.length ? "found" : "attention"}
          >
            <AudienceList profile={profile} patch={patch} heading={false} />
          </Section>

          <Section title="Where your content lives" line={siteLine.line} initialOpen={false} state={siteLine.badge}>
            <SiteFields site={site} setSite={editSite} domain={domain} advanced>
              <div className="flex flex-col items-start gap-3 rounded-[8px] border border-line bg-bg px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-[13px] font-medium">Connect Google Search Console</div>
                  <div className="text-[12px] text-ink-3">So research starts from searches Google already shows you for, and can show real clicks later.</div>
                </div>
                {/* New tab: this screen saves as you go, but the click below is what confirms it. */}
                <a
                  href="/connect/google"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center rounded-[7px] border border-line bg-bg px-[9px] py-[5px] text-[12.5px] font-medium text-ink transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Connect
                </a>
              </div>
            </SiteFields>
          </Section>
        </div>
      </div>

      {/* Fixed, so the button is never a scroll away. One button: there is no
          Back because there is nowhere to go back to, and no Skip because
          nothing left on this screen is worth skipping - the settings that
          were live in Settings with the defaults we would have picked. Under
          640px it stacks: one short line over a full-width button. Anything
          that stops the button is said here, beside it. */}
      <div ref={barRef} className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-[720px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
          <div className="min-w-0">
            {blocker ? (
              <p id={BLOCKER_ID} role="alert" className="m-0 rounded-lg bg-err-soft px-3 py-2 text-[12.5px] leading-[1.5] text-err-ink">
                {blocker}
              </p>
            ) : (
              <>
                <p className="m-0 hidden text-[12.5px] leading-[1.5] text-ink-2 sm:block">{next.full}</p>
                <p className="m-0 text-[12.5px] leading-[1.5] text-ink-2 sm:hidden">{next.short}</p>
              </>
            )}
          </div>
          <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
            {editing && (
              <button
                type="button"
                onClick={leaveEditing}
                disabled={pending}
                className="text-center text-[12.5px] text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
              >
                Back without changing anything
              </button>
            )}
            <Button
              variant="accent"
              className="w-full justify-center py-2.5 sm:w-auto sm:py-[7px]"
              onClick={() => finish()}
              disabled={pending || reading}
              aria-describedby={blocker ? BLOCKER_ID : undefined}
            >
              {pending ? "Saving…" : editing ? "Try again with these changes" : trialEligible ? "Write my first article" : "Plan my first articles"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Where the wizard sends a person whose blocker is in the offerings list. */
export const OFFERINGS_INPUT_ID = "wizard-offerings-input";
const BLOCKER_ID = "wizard-blocker";

type SectionState = "found" | "looking" | "attention" | "optional";

/**
 * A collapsible section whose closed state still shows what is inside it.
 *
 * `<details>`, so the browser owns the toggle and a person can open anything.
 * The summary carries the section's actual content on one line, not a
 * checkbox: "ready" is a claim, and the collapsed sections are the ones the
 * model is trusted on - which is exactly where a confident wrong answer would
 * hide behind a tick.
 *
 * Open is the initial state only, then the person's: nothing typed opens or
 * closes it. The Found / Needs a look badge holds still while focus is inside
 * the section and catches up when focus leaves it, so it never flips under a
 * half-typed value. `footer` stays in view while the section is closed (the
 * business section's language and market, with their Change link).
 */
export function Section({
  title,
  line,
  initialOpen,
  state,
  footer,
  children,
}: {
  title: string;
  line: string;
  initialOpen: boolean;
  state: SectionState;
  footer?: (open: () => void) => React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  // The badge as it was when focus came in; null while focus is elsewhere.
  const [held, setHeld] = useState<SectionState | null>(null);
  const shown = held ?? state;
  return (
    <div
      className="rounded-[10px] border border-line bg-panel"
      onFocus={() => {
        if (held === null) setHeld(state);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(null);
      }}
    >
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[10px] px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:px-5 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <h2 className="m-0 text-[13.5px] font-medium text-ink">{title}</h2>
            <p className="m-0 mt-0.5 truncate text-[12.5px] text-ink-2 group-open:hidden">{line}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px]">
            <SectionBadge state={shown} />
            <span className="text-ink-3 transition-transform group-open:rotate-180">
              <Icons.caretDown size={12} />
            </span>
          </div>
        </summary>
        <div className="border-t border-line px-4 py-5 sm:px-5">{children}</div>
      </details>
      {footer && !open && <div className="-mt-2 px-4 pb-3.5 sm:px-5">{footer(() => setOpen(true))}</div>}
    </div>
  );
}

export function SectionBadge({ state }: { state: SectionState }) {
  if (state === "found") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-ok-ink">
        <Icons.check size={10} /> Found
      </span>
    );
  }
  if (state === "looking") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-ink-3">
        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent motion-reduce:animate-none" /> Looking
      </span>
    );
  }
  if (state === "optional") return <span className="rounded-full border border-line px-2 py-0.5 text-ink-3">Optional</span>;
  return <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn-ink">Needs a look</span>;
}

/** The wait, with the work named. */
function ReadingSite({ domain, autoStart = false }: { domain: string; autoStart?: boolean }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-[560px] text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink-2">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Reading {domain}…
        </div>
        <h1 className="mb-2 text-[22px] font-semibold">{autoStart ? "Reading your site" : "Setting up your site"}</h1>
        <p className="mx-auto max-w-[420px] text-[13.5px] leading-[1.6] text-ink-2">
          {autoStart
            ? "What you sell, who buys it and who you compete with, from your homepage and your blog. Your first article starts as soon as we know, with nothing to fill in."
            : "We read your homepage, and your blog if the homepage is thin, to fill in what we can. The next screen is a check rather than a form. About a minute."}
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
  // Always carries its own sentence (which limit, or that an operator is
  // viewing); this is only the fallback.
  limited: "This site has been read as many times as setup allows for now. Fill this in by hand.",
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

/**
 * A setup cut short by a provider that did not answer (UX audit 2026-10-12,
 * #16): said as ours, with no retry button - running it again now buys the
 * same outage - and no card. "We try again" only when the overnight sweep
 * may start the run (lib/onboarding/provider-retry.ts asks the same spend
 * gate); the email when the article is written is the one every first
 * article sends (lib/email/draft-batch.ts).
 */
export const PROVIDER_DOWN_HEADING = "We could not reach our search data just now";
export function providerDownLede(domain: string, retryAllowed: boolean): string {
  const lead = `We could not check what your buyers search for, because the service we get search data from did not answer. That is a problem on our side, not with ${domain || "your site"}, and nothing was charged.`;
  return retryAllowed ? `${lead} We try again automatically, usually overnight, and email you when your first article is written.` : lead;
}
const FIRST_ARTICLE_FAILED_LEDE =
  `Setup started writing it and it failed on our side. It is written again once your ${TRIAL_DAYS}-day trial starts.`;

/**
 * The heading and lede for an ending, before the trial. An article's own
 * words follow it being written (first-look-gate.tsx `articleHeading`), so
 * "article" here is only the fallback for a page that has not read it yet.
 */
function endingWords(
  ending: SetupEnding,
  ctx: { domain: string; runState: Pick<OnboardingState, "steps" | "emptyPool"> | null; setupAllowed?: boolean },
): { heading: string; lede: string } {
  const draftingDetail = ctx.runState?.steps.find((s) => s.phase === "drafting")?.detail ?? null;
  switch (ending) {
    case "article":
      return { heading: "Your first article", lede: `Start your ${TRIAL_DAYS}-day trial to read it in full, approve it and publish it.` };
    case "writing":
      return { heading: "Your first article is being written", lede: "It appears here when it is done, usually within a few minutes." };
    case "provider-down":
      return { heading: PROVIDER_DOWN_HEADING, lede: providerDownLede(ctx.domain, ctx.setupAllowed ?? false) };
    case "retry":
      return { heading: "Setup did not finish", lede: `Nothing was written for ${ctx.domain || "your site"}. Running setup again reads the site, picks your first topic and writes your first article.` };
    case "first-failed":
      return { heading: FIRST_ARTICLE_FAILED_HEADING, lede: FIRST_ARTICLE_FAILED_LEDE };
    case "nothing-planned":
      return { heading: NOTHING_PLANNED_HEADING, lede: nothingPlannedLede(ctx.domain, ctx.runState?.emptyPool ?? null) };
    case "no-article":
      return {
        heading: "No article was written in setup",
        lede: `${draftingDetail ? `Setup said: ${draftingDetail}` : "Setup finished without writing an article."} The trial opens the calendar, where articles can be written from the plan.`,
      };
  }
}

/**
 * The page the gate sits on, with room at the bottom for the slim ask bar.
 * `wide` once there is something to read: the article and, from lg, the
 * trial rail beside it (`--gate-rail`). What follows the gate's top (the
 * folds, the run log) stays in the article's column (`gateColumn`).
 */
function GateShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-bg [--gate-rail:340px]">
      <div className={`mx-auto px-4 pb-36 pt-8 sm:px-6 sm:pt-10 lg:pb-16 ${wide ? "max-w-[1140px]" : "max-w-[680px]"}`}>{children}</div>
    </div>
  );
}

/** Under the gate's top, the article's column: clear of the rail from lg. */
const gateColumn = "lg:pr-[calc(var(--gate-rail)+1.5rem)]";

function RetryBox({ line, label, onRetry, onEdit }: { line: string; label: string; onRetry: () => void; onEdit?: () => void }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel p-4">
      <p className="m-0 mb-3 text-sm">{line}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="accent" onClick={onRetry}>
          {label}
        </Button>
        {onEdit && (
          <button type="button" onClick={onEdit} className="text-[12.5px] text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink">
            Change what we found first
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The way forward from a setup that planned nothing: change what we found
 * about the site and run it once more, free. Before this, the only control
 * on that screen was Sign out (UX audit 2026-10-12, #3). Offered only when
 * the spend gate would start the run (`setupAllowed`), so it is never a
 * button the server refuses; the gate's own count of pre-trial runs is what
 * stops a loop.
 */
function ChangeBox({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel p-4">
      <p className="m-0 mb-3 text-[13px] leading-[1.6] text-ink-2">
        If we got what you sell, who buys it or who you compete with wrong, change it and we will look again. One more try is free.
      </p>
      <Button variant="accent" onClick={onEdit}>
        Change what we found and try again
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
  onEdit,
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
  welcome = null,
  userEmail,
  otherSites = [],
  offer,
}: {
  /** Reopen the wizard for the one more run the spend gate allows; absent when it would refuse. */
  onEdit?: () => void;
  offer: TrialOfferFacts;
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
  welcome?: GateWelcome | null;
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
    // A run read back days later may be past the overnight retry's window.
    providerRetryOpen: providerRetryWindowOpen(run?.run?.finished_at),
  });
  const words = endingWords(ending, { domain, runState, setupAllowed: setup.setupAllowed });
  const written = firstArticle?.state === "written";

  return (
    <GateShell wide>
      <GateTop
        workspaceId={workspaceId}
        canBuy={canBuy}
        ending={ending}
        heading={words.heading}
        lede={words.lede}
        retry={
          ending === "retry" ? (
            <RetryBox
              line={runState ? "The last setup run stopped before it wrote an article." : "Setup was skipped, so no article has been written yet."}
              label={runState ? "Run setup again" : "Write my first article"}
              onRetry={onRetry}
              onEdit={canBuy ? onEdit : undefined}
            />
          ) : ending === "nothing-planned" && canBuy && onEdit ? (
            <ChangeBox onEdit={onEdit} />
          ) : null
        }
        firstArticle={firstArticle}
        planned={planned}
        fullArticle={fullArticle}
        initialHtml={initialHtml}
        offer={offer}
        held={held?.count ?? 0}
        nextArticles={nextArticles(planned, held?.topics, firstArticle?.keyword)}
        welcome={welcome}
        startedAt={run?.run && Number.isFinite(Date.parse(run.run.started_at)) ? Date.parse(run.run.started_at) : null}
      />

      <div className={`mt-6 flex flex-col gap-2 ${gateColumn}`}>
        {planned.length > 0 && (
          <Fold
            title="Your plan"
            line={`${planned.length} ${planned.length === 1 ? "article" : "articles"} scheduled${held && held.count > 0 ? `, ${held.count} more ready for your trial` : ""}`}
          >
            <PlanRows planned={planned} firstArticle={firstArticle} written={written} />
            {planned.length > (firstArticle ? 1 : 0) && (
              <p className="m-0 text-[12px] text-ink-2">
                {firstArticle ? `The other ${planned.length - 1} start writing when your trial does.` : "These start writing when your trial does."}
              </p>
            )}
          </Fold>
        )}
        {report && (
          <Fold
            title="Your site report"
            line={reportLine(report, domain)}
          >
            <FirstLookReportView report={report} domain={domain} live={false} />
          </Fold>
        )}
      </div>
      <div className={gateColumn}>
        <SignOutLine email={userEmail} otherSites={otherSites} />
      </div>
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
  onEdit,
  workspaceId,
  canBuy,
  domain,
  freeDrafts,
  trialEligible,
  initialRun,
  firstArticle,
  firstArticleWriting,
  fullArticle = false,
  initialHtml = null,
  preTrialSetup,
  userEmail,
  otherSites = [],
  offer,
  profile = null,
}: {
  /** Reopen the wizard for the one more run the spend gate allows; absent when it would refuse. */
  onEdit?: () => void;
  offer: TrialOfferFacts;
  /** What the site read found, shown beside the run while it is live. */
  profile?: BusinessProfile | null;
  fullArticle?: boolean;
  initialHtml?: string | null;
  workspaceId: string;
  canBuy: boolean;
  domain: string;
  freeDrafts: number | null;
  trialEligible: boolean;
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
  // When the run started, on this browser's clock: the one clock from the
  // click to the written article runs on into the gate's article card.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(() => {
    const at = initialRun?.run ? Date.parse(initialRun.run.started_at) : NaN;
    return Number.isFinite(at) ? at : null;
  });
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
  // "Wrong? Fix it and start over" (lib/onboarding/stop-to-change.ts). The
  // run on screen, as /api/onboard/start named it, and whether the spend
  // gate would start one more setup run after it: asked once per run, once
  // the run exists, so the gate's count includes it. Only for the owner, and
  // only when the page already found setup allowed (`onEdit`), because the
  // link ends in that same form.
  const [restart, setRestart] = useState<{ runId: string; allowed: boolean | null } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const askRestart = trialEligible && canBuy && onEdit !== undefined;
  const early = state === null || stoppableToChange(state.steps);
  const onRun = useCallback((runId: string) => {
    setRestart((r) => (r?.runId === runId ? r : { runId, allowed: null }));
  }, []);
  useEffect(() => {
    if (!askRestart || !early || !restart || restart.allowed !== null) return;
    const runId = restart.runId;
    let gone = false;
    void mayStartSetupOver(workspaceId, runId).then((allowed) => {
      if (!gone) setRestart((r) => (r?.runId === runId ? { runId, allowed } : r));
    });
    return () => {
      gone = true;
    };
  }, [askRestart, early, restart, workspaceId]);
  const offerRestart =
    askRestart && offerStopToChange(state, { restartable: restart?.allowed ?? null, firstAttempted: preTrialSetup.firstAttempted });
  // Stop this run, then open "Change what we found" over it; its button
  // starts the next run. On a refusal the reason stays under the panel.
  const startOver = () => {
    if (!restart || !onEdit || stopping) return;
    setStopping(true);
    setStopError(null);
    stopSetupToChange(workspaceId, restart.runId).then(
      (r) => {
        if (r.ok) return onEdit();
        setStopping(false);
        setStopError(r.message);
      },
      () => {
        setStopping(false);
        setStopError("Could not stop setup. Try again.");
      },
    );
  };

  const retryRun = () => {
    setState(null);
    setRestart(null);
    setAttempt((a) => a + 1);
  };

  if (trialEligible) {
    const words = ending ? endingWords(ending, { domain, runState: state, setupAllowed: preTrialSetup.setupAllowed }) : null;
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
    // Beside the live run, what it is building on; the gate replaces it. It
    // is never edited in place: the worker read the language, the market and
    // the profile when it started, and /api/onboard/start hands back the run
    // already going. While the run is still reading the site, its owner may
    // stop it and change what we found (`startOver`); after that, the free
    // re-run is offered where it can be kept, once the run has ended.
    const understood =
      !trialStep && profile ? (
        <WhatWeUnderstood
          profile={profile}
          domain={domain}
          onRestart={offerRestart ? startOver : undefined}
          restarting={stopping}
          restartError={stopError}
        />
      ) : undefined;
    return (
      <GateShell wide={trialStep || understood !== undefined}>
        {trialStep && ending && words ? (
          <GateTop
            workspaceId={workspaceId}
            canBuy={canBuy}
            ending={ending}
            heading={words.heading}
            lede={words.lede}
            retry={
              ending === "retry" ? (
                <RetryBox line="Setup stopped before it wrote your first article." label="Run setup again" onRetry={retryRun} onEdit={canBuy ? onEdit : undefined} />
              ) : ending === "nothing-planned" && canBuy && onEdit ? (
                <ChangeBox onEdit={onEdit} />
              ) : null
            }
            firstArticle={firstArticle}
            pending={runDraft ? { title: runDraft.title, keyword: runDraft.keyword, wordCount: runDraft.wordCount, outlined: runDraft.outlined === true } : null}
            planned={planned}
            fullArticle={fullArticle}
            initialHtml={initialHtml}
            onBodyDone={() => setBodyLanded((n) => n + 1)}
            offer={offer}
            held={held?.count ?? 0}
            nextArticles={nextArticles(planned, held?.topics, firstArticle?.keyword ?? runDraft?.keyword)}
            startedAt={runStartedAt}
          />
        ) : null}
        <div className={trialStep ? `mt-6 ${gateColumn}` : undefined}>
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
            onStartedAt={setRunStartedAt}
            onRun={onRun}
            understood={understood}
            articleExists={firstArticle?.state === "written"}
          />
        </div>
        {trialStep ? (
          <div className={gateColumn}>
            <SignOutLine email={userEmail} otherSites={otherSites} />
          </div>
        ) : null}
      </GateShell>
    );
  }

  // "Open my first draft" opens that draft, not /review (the filtered
  // Articles list), on a screen the editor fits; a phone gets the dashboard,
  // whose Next up links it, as after checkout (firstArticleReturn).
  const next = planned.length > 0
    ? { href: "/content", label: "Open my plan" }
    : draft
      ? { href: `/content/${draft.id}`, label: "Open my first draft", articleId: draft.id }
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
                <Button
                  variant="accent"
                  onClick={() =>
                    router.push(
                      "articleId" in next
                        ? firstArticleReturn(next.articleId, window.matchMedia?.(EDITOR_FITS_QUERY).matches ?? true)
                        : next.href,
                    )
                  }
                >
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
