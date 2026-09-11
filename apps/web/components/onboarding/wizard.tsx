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
import { Button } from "@/components/ui";
import {
  proposeProfile,
  saveProfile,
  discoverSiteDetails,
  saveSiteDetails,
  saveOutputSettings,
  completeWizard,
} from "@/app/actions/onboarding-wizard";
import { setAutoApprove } from "@/app/actions/workspaces";
import { saveAttribution } from "@/app/actions/attribution";
import { AttributionPicker, EMPTY_ATTRIBUTION, attributionComplete, type AttributionDraft } from "@/components/onboarding/attribution-picker";
import type { OutputSettings, SiteDetails } from "@/lib/onboarding/output-settings";
import { EMPTY_PROFILE, type BusinessProfile, type InferenceReason } from "@/lib/onboarding/business-profile";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
// The forms themselves live in components/settings: every wizard screen is
// also a permanent Settings tab, and one copy of each form keeps them in step.
import { BusinessFields } from "@/components/settings/business-fields";
import { AudienceList, CompetitorList, OfferingList } from "@/components/settings/audience-fields";
import { SiteFields } from "@/components/settings/site-fields";
import { ApprovalGateCard, OutputFields } from "@/components/settings/output-fields";
import { IntegrationIcon } from "@/components/dashboard/integration-icon";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import {
  onboardingOutcome,
  shouldResumeRun,
  type OnboardingArticle,
  type OnboardingPlanned,
  type OnboardingRunSnapshot,
  type OnboardingState,
} from "@/lib/onboarding/events";
import { freeAllowanceClause } from "@/lib/onboarding/copy";
import { StartTrialButton } from "@/components/billing/start-trial-button";
import { FirstLookReportView } from "@/components/onboarding/first-look-report";
import type { FirstLookReport } from "@/lib/onboarding/first-look-report";
import { TRIAL_OFFER } from "@/lib/billing/trial";
import { SITE_STEPS, stepFromParam, stepIndex } from "@/lib/onboarding/steps";
import posthog from "posthog-js";

// The question about the person, after every step about the site. Present only
// while the account has not answered; a second workspace goes straight to plan.
const ATTRIBUTION_STEP = SITE_STEPS.length;
export type Destination = { id: string; name: string; description: string | null };

/** The screen the address bar is asking for; see `stepFromParam`. */
function stepFromLocation(count: number): number {
  if (typeof window === "undefined") return 0;
  return stepFromParam(new URLSearchParams(window.location.search).get("step"), count);
}

export function OnboardingWizard({
  workspaceId,
  userId,
  userEmail,
  userProfileName,
  domain,
  weeklyLimit,
  freeDrafts,
  trialEligible = false,
  initialProfile,
  initialSite,
  initialOutput,
  askAttribution,
  alreadyOnboarded = false,
  gatePlan = [],
  gateReport = null,
  initialRun = null,
  initialStep = 0,
  initialAutoApprove,
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
  initialProfile: BusinessProfile | null;
  initialSite: SiteDetails;
  initialOutput: OutputSettings;
  askAttribution: boolean;
  /** From `?step=`, read by the server page so a deep link paints the right screen first. */
  initialStep?: number;
  /** The workspace's publishing decision as saved (079); signup sets it on, "Add workspace" leaves it off. */
  initialAutoApprove: boolean;
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
  /** The analysis already run on this account's site, shown open on the gate. */
  gateReport?: FirstLookReport | null;
  initialRun?: OnboardingRunSnapshot | null;
}) {
  const identifiedUserId = useRef<string | null>(null);
  const steps: string[] = askAttribution ? [...SITE_STEPS, "About you"] : [...SITE_STEPS];

  useEffect(() => {
    if (identifiedUserId.current === userId) return;
    posthog.identify(userId, {
      ...(userEmail ? { email: userEmail } : {}),
      ...(userProfileName ? { name: userProfileName } : {}),
    });
    identifiedUserId.current = userId;
  }, [userEmail, userId, userProfileName]);
  const last = steps.length - 1;
  // The step, mirrored into the URL.
  //
  // It used to live only in React state, so the wizard was one history entry:
  // pressing browser Back on step 3 left the wizard entirely and landed on the
  // dashboard, with the screen's unsaved answers gone and - because step 1's
  // Continue has already written a business_profile - nothing to send the
  // person back. Reloading restarted at step 1 for the same reason.
  //
  // `history.pushState` with a query string is the shallow update Next
  // documents for exactly this: no server round trip, so the component is not
  // remounted and nothing typed is lost, and the browser's own Back now moves
  // one screen instead of leaving. The steps that have already been passed are
  // persisted server-side, so a reload rehydrates them from `initialProfile`,
  // `initialSite` and `initialOutput` and puts the person back where they were.
  // The screen itself comes from the server page, which read `?step=` - so a
  // deep link (the follow-up email's, a reload) paints that screen first
  // instead of the first one and a jump after hydration.
  const [step, setStep] = useState(initialStep);
  const [autoApprove, setAutoApproveState] = useState(initialAutoApprove);
  const [attribution, setAttribution] = useState<AttributionDraft>(EMPTY_ATTRIBUTION);
  const [profile, setProfile] = useState<BusinessProfile | null>(initialProfile);
  const [site, setSite] = useState<SiteDetails>(initialSite);
  const [output, setOutput] = useState<OutputSettings>(initialOutput);
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

  /** Move to a screen and leave a history entry for the one being left. */
  function goToStep(n: number) {
    setStep(n);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", n === 0 ? window.location.pathname : `?step=${n + 1}`);
    }
  }

  // Back and Forward. Nothing is re-fetched: the answers are in state, and
  // the ones already saved are on the server either way.
  useEffect(() => {
    const sync = () => setStep(stepFromLocation(steps.length));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [steps.length]);

  // Read the site. A failure is a normal outcome and is shown as one. Not
  // while a run is on screen: that page has already been through this.
  useEffect(() => {
    if (!reading || running) return;
    let cancelled = false;
    proposeProfile(workspaceId)
      .then((r) => {
        if (cancelled) return;
        setProfile(r.profile ?? EMPTY_PROFILE);
        setReadFailure(r.profile ? null : r.reason);
        // A billing refusal names this account's own state, so it travels as
        // a sentence rather than as a key into the copy map.
        setReadFailureMessage(r.profile ? null : r.message ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setProfile(EMPTY_PROFILE);
        setReadFailure("model_failed");
        setReadFailureMessage(null);
      })
      .finally(() => !cancelled && setReading(false));
    return () => {
      cancelled = true;
    };
  }, [reading, running, workspaceId]);

  // Look for the sitemap and blog in the background while step 1 is on screen,
  // so step 3 opens with an answer rather than a spinner.
  useEffect(() => {
    if (discovery !== "pending" || running) return;
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
  }, [discovery, running, workspaceId]);

  function patch(next: Partial<BusinessProfile>) {
    setProfile((p) => (p ? { ...p, ...next } : p));
  }

  /** Persist the screen being left. Each step owns one save. */
  async function persist(s: number) {
    if ((s === 0 || s === 1) && profile) await saveProfile(workspaceId, profile);
    if (s === 2) await saveSiteDetails(workspaceId, site);
    if (s === 3) {
      await saveOutputSettings(workspaceId, output);
      // Saved with the screen that asked it. 24h and a floor of 70 are the
      // defaults the settings card shows; both can be changed there later.
      await setAutoApprove(workspaceId, { enabled: autoApprove, holdHours: 24, minSeo: 70 });
    }
    // Optional: saved only when actually answered, never as a blank.
    const source = attribution.source;
    if (s === ATTRIBUTION_STEP && source && attributionComplete(attribution)) await saveAttribution(source, attribution.note);
  }

  function next() {
    setError(null);
    start(async () => {
      try {
        await persist(step);
        if (step !== last) {
          goToStep(step + 1);
        } else {
          await completeWizard(workspaceId);
          posthog.capture("onboarding_completed", { workspace_id: workspaceId });
          setRunning(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save this step.");
      }
    });
  }

  /** Leave this screen as it is - nothing typed on it is saved - and move on. */
  function skipStep() {
    setError(null);
    goToStep(step + 1);
  }


  // Sent here by the dashboard gate, with no run recent enough to resume.
  // There is nothing to show the progress of and nothing to set up again -
  // only the card stands between this account and the product.
  if (!running && alreadyOnboarded && trialEligible) {
    return <TrialGateScreen domain={domain} planned={gatePlan} report={gateReport} />;
  }

  if (running) {
    return <RunScreen workspaceId={workspaceId} domain={domain} weeklyLimit={weeklyLimit} freeDrafts={freeDrafts} trialEligible={trialEligible} initialRun={resumed} />;
  }

  if (reading || !profile) return <ReadingSite domain={domain} />;

  return (
    <div className="min-h-screen bg-bg">
      <Stepper steps={steps} current={step} />

      <div className="mx-auto max-w-[720px] px-6 pb-28 pt-8">
        {step === 0 && (
          <BusinessStep
            profile={profile}
            patch={patch}
            domain={domain}
            failure={readFailure}
            failureMessage={readFailureMessage}
            onRetry={() => {
              setReadFailure(null);
              setReadFailureMessage(null);
              setReading(true);
            }}
          />
        )}
        {step === 1 && <AudienceStep profile={profile} patch={patch} />}
        {step === 2 && <BlogStep site={site} setSite={setSite} discovery={discovery} domain={domain} />}
        {step === 3 && <ArticlesStep output={output} setOutput={setOutput} autoApprove={autoApprove} setAutoApprove={setAutoApproveState} />}
        {step === ATTRIBUTION_STEP && <AttributionStep value={attribution} onChange={setAttribution} />}
        {step === last && <NextUp weeklyLimit={weeklyLimit} freeDrafts={freeDrafts} autoApprove={autoApprove} />}
        {error && <p className="mt-4 rounded-lg bg-err-soft px-3 py-2 text-[12.5px] text-err-ink">{error}</p>}
      </div>

      {/* The bar is fixed because the Articles step is long and a Continue you
          have to scroll for reads as a dead end. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-[720px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => goToStep(Math.max(0, step - 1))}
              disabled={step === 0 || pending}
            >
              Back
            </Button>
            {/* Every screen can be skipped on its own: nothing typed on it is
                saved and the next one opens. The last step has no link because
                Finish is the way out. Skipping the setup wholesale is not
                offered: the run is the product, and an account that skips it
                lands on an empty dashboard with nothing to react to. */}
            {step !== last && (
              <button
                type="button"
                onClick={skipStep}
                disabled={pending}
                className="text-[12px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink"
              >
                Skip this step
              </button>
            )}
          </div>
          <Button
            variant="accent"
            onClick={next}
            disabled={pending}
          >
            {pending
              ? "Saving…"
              : step !== last
                ? "Continue"
                : "Finish and plan my first month"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-[860px] items-center gap-2 overflow-x-auto px-6 py-4">
        {steps.map((label, i) => (
          <div key={label} className="flex items-center gap-2 whitespace-nowrap">
            <span
              className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
                i < current ? "bg-accent text-bg" : i === current ? "border-2 border-accent" : "border border-line"
              }`}
            >
              {i < current ? "✓" : ""}
            </span>
            <span className={`text-[12.5px] ${i <= current ? "text-ink" : "text-ink-3"}`}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-line" />}
          </div>
        ))}
      </div>
    </div>
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
          We read your homepage, and your blog if the homepage is thin, to fill in what we can. The next few
          screens are a check rather than a form. About a minute.
        </p>
      </div>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="mb-6 text-center">
      <h1 className="mb-1.5 text-[21px] font-semibold">{title}</h1>
      <p className="text-[13px] text-ink-2">{sub}</p>
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

function BusinessStep({
  profile,
  patch,
  domain,
  failure,
  failureMessage,
  onRetry,
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
  domain: string;
  failure: InferenceReason | null;
  /** Set when the refusal carries its own sentence (see InferenceResult). */
  failureMessage: string | null;
  onRetry: () => void;
}) {
  return (
    <>
      <Head
        title="About your business"
        sub={
          failure
            ? failure === "needs_plan"
              ? "This needs a plan."
              : `We could not fill this in from ${domain}.`
            : "Based on your website, we've filled this in. Check it and correct anything wrong."
        }
      />
      {failure && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-[10px] border border-line bg-panel p-4">
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink-2">{failureMessage ?? FAILURE_COPY[failure]}</p>
          {failure !== "no_model" && failure !== "needs_plan" && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
      <div className="rounded-[10px] border border-line bg-panel p-5">
        <BusinessFields profile={profile} patch={patch} />
      </div>
    </>
  );
}

function AudienceStep({ profile, patch }: { profile: BusinessProfile; patch: (p: Partial<BusinessProfile>) => void }) {
  return (
    <>
      <Head
        title="What you sell, who buys it, and who you sell against"
        sub="Keyword research starts from these three lists, and every keyword remembers which of them it came from. Remove anything that is not you."
      />
      <div className="mb-4 rounded-[10px] border border-line bg-panel p-5">
        <OfferingList profile={profile} patch={patch} />
      </div>
      <div className="mb-4 rounded-[10px] border border-line bg-panel p-5">
        <AudienceList profile={profile} patch={patch} />
      </div>
      <div className="rounded-[10px] border border-line bg-panel p-5">
        <CompetitorList profile={profile} patch={patch} />
      </div>
    </>
  );
}

function BlogStep({
  site,
  setSite,
  discovery,
  domain,
}: {
  site: SiteDetails;
  setSite: (s: SiteDetails) => void;
  discovery: SiteDiscovery | null | "pending";
  domain: string;
}) {
  const looking = discovery === "pending";
  const found = discovery && discovery !== "pending" && discovery.found;
  const sub = looking
    ? `Looking for a sitemap and a blog on ${domain}…`
    : found
      ? "We found these on your site. Correct them if they are wrong."
      : `We could not find a sitemap or a blog on ${domain}. Add them if you have them; both are optional.`;
  return (
    <>
      <Head title="Where your content lives" sub={sub} />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <SiteFields site={site} setSite={setSite} domain={domain} />
        <div className="flex items-center justify-between rounded-[8px] border border-line bg-bg px-4 py-3">
          <div>
            <div className="text-[13px] font-medium">Connect Search Console</div>
            <div className="text-[12px] text-ink-3">So we skip keywords you already rank for, and can show real clicks later.</div>
          </div>
          {/* New tab, for the same reason as the destination tiles below:
              this screen's answers are not saved until Continue. */}
          <a href="/connect/google" target="_blank" rel="noreferrer">
            <Button size="sm">Connect</Button>
          </a>
        </div>
      </div>
    </>
  );
}

function ArticlesStep({
  output,
  setOutput,
  autoApprove,
  setAutoApprove,
}: {
  output: OutputSettings;
  setOutput: (o: OutputSettings) => void;
  autoApprove: boolean;
  setAutoApprove: (v: boolean) => void;
}) {
  return (
    <>
      <Head title="How your articles should read" sub="Set once. Every draft follows these until you change them in Settings." />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <ApprovalGateCard value={autoApprove} onChange={setAutoApprove} />
        <OutputFields output={output} setOutput={setOutput} />
      </div>
    </>
  );
}

function NextUp({ weeklyLimit, freeDrafts, autoApprove }: { weeklyLimit: number; freeDrafts: number | null; autoApprove: boolean }) {
  const allowance = freeAllowanceClause(freeDrafts);
  return (
    <p className="mt-6 text-center text-[12.5px] leading-[1.6] text-ink-2">
      Next: we read your site properly, find what to write about, schedule up to{" "}
      <strong className="font-medium text-ink">
        {weeklyLimit >= 7 ? "one article a day" : `${weeklyLimit} article${weeklyLimit === 1 ? "" : "s"} a week`}
      </strong>{" "}
      for the next 30 days (only keywords that pass our checks make the plan), and write the first one.{" "}
      {autoApprove
        ? "Each draft is emailed to you and publishes a day later unless you hold it."
        : "Every draft waits in review."}
      {allowance ? ` ${allowance}` : ""}
    </p>
  );
}

/**
 * The one question about the person. The copy says why we ask, because a
 * question with no visible reason gets the answer that closes it fastest, and
 * the answer we most need to be true is the one about AI.
 */
function AttributionStep({
  value,
  onChange,
}: {
  value: AttributionDraft;
  onChange: (v: AttributionDraft) => void;
}) {
  return (
    <>
      <Head
        title="One last thing"
        sub="How did you hear about us? Pick the closest, or finish without answering. It is the only way we can tell whether an AI answer sent you here, which is the thing we sell."
      />
      <div className="rounded-[10px] border border-line bg-panel p-5">
        <AttributionPicker value={value} onChange={onChange} />
      </div>
    </>
  );
}

/** "Sep 7" from a YYYY-MM-DD, in UTC so the day the planner wrote is the day shown. */
function calendarDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const VERDICT_LABEL: Record<OnboardingArticle["verdict"], { text: string; className: string }> = {
  clean: { text: "Fact check passed", className: "text-ok" },
  review: { text: "Fact check: review", className: "text-warn" },
  high_risk: { text: "Fact check: needs work", className: "text-err" },
};

/**
 * The card, for an account that is already set up.
 *
 * The trial ask at the end of a run has the run to point at: drafts written,
 * a month scheduled. This one has none of that - it is what somebody sees on
 * their second visit, or their thirtieth - so it asks plainly and says what
 * the trial opens rather than pretending there is a setup in progress.
 */
function TrialGateScreen({
  domain,
  planned,
  report,
}: {
  domain: string;
  planned: OnboardingPlanned[];
  report: FirstLookReport | null;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[860px] px-6 py-10">
        <div className="mb-6 text-center">
          <h1 className="m-0 mb-1.5 text-[22px] font-semibold">Start your trial to continue</h1>
          <p className="mx-auto m-0 max-w-[520px] text-[13.5px] leading-[1.6] text-ink-2">
            {domain ? `Everything below is already done for ${domain}. ` : ""}
            The trial opens approving, publishing and the rest of the schedule.
          </p>
        </div>

        {/* The ask stays in the first screenful, above everything it unlocks. */}
        <div className="mx-auto mb-6 max-w-[640px] rounded-[10px] border border-accent/40 bg-panel p-5">
          <div className="rounded-[8px] bg-accent/5 p-4">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-accent">7-day trial</div>
            <p className="m-0 mb-3 text-[13.5px] leading-[1.6]">{TRIAL_OFFER}</p>
            <StartTrialButton returnTo="/dashboard" onError={setError} />
            {error && (
              <p className="m-0 mt-2.5 text-[12.5px] leading-[1.5] text-err-ink" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          {planned.length > 0 && (
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <div className="text-[12.5px] font-medium text-ink">Your first month</div>
                <div className="text-[11.5px] text-ink-3">
                  {planned.length} {planned.length === 1 ? "article" : "articles"} scheduled
                </div>
              </div>
              {/* Locked, not hidden. The plan is real and was built for this
                  account; what the trial buys is the writing of it, so the
                  terms stay legible through the lock rather than being
                  blurred into a teaser of something that might not exist. */}
              <div className="relative overflow-hidden rounded-[8px] border border-line bg-bg">
                <ul className="m-0 max-h-[220px] list-none divide-y divide-line overflow-hidden p-0 opacity-45">
                  {planned.slice(0, 8).map((p) => (
                    <li key={`${p.date}-${p.term}`} className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
                      <span className="truncate">{p.term}</span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{calendarDay(p.date)}</span>
                    </li>
                  ))}
                </ul>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center bg-gradient-to-t from-bg via-bg/85 to-transparent pb-3 pt-10">
                  <span className="text-[12px] font-medium text-ink-2">
                    Start the trial to unlock the schedule
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Not locked. This was measured on their own public pages and it is
              the evidence the ask rests on; hiding it would leave the gate
              asking for a card on nothing. */}
          {report && <FirstLookReportView report={report} domain={domain} live={false} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The last step of onboarding: the card.
 *
 * The order is the point. The setup has just written the account's first
 * drafts against the free allowance and the person is looking at them: title,
 * keyword, length, fact-check verdict, and the thirty days scheduled behind
 * them. What the trial buys is the next thing they would do with what they
 * are looking at (approve, publish, keep writing), so the ask is made here,
 * before the dashboard, and not from a banner they find later. There is no
 * skip: the schedule starts when the trial does, so a person who leaves from
 * here has nothing running to come back to.
 */
function TrialStep({
  drafts,
  planned,
  returnTo,
}: {
  drafts: OnboardingArticle[];
  planned: OnboardingPlanned[];
  returnTo: string;
}) {
  const words = drafts.reduce((n, d) => n + d.wordCount, 0);
  return (
    <div className="mx-auto mb-6 max-w-[640px] rounded-[10px] border border-accent/40 bg-panel p-5">
      {/* The ask comes first. Everything below it is the evidence for it, and
          an earlier arrangement put the evidence on top: on a site with a full
          report the button sat a full screen down and was never seen. */}
      <div className="rounded-[8px] bg-accent/5 p-4">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-accent">7-day trial</div>
        <p className="m-0 mb-3 text-[13.5px] leading-[1.6]">
          <strong>Approve, publish and keep writing.</strong> {TRIAL_OFFER}
        </p>
        <StartTrialButton returnTo={returnTo} />
      </div>

      {planned.length > 0 && (
        <p className="m-0 mt-5 text-[13px] leading-[1.6] text-ink-2">
          {/* "on the calendar", not "more": the plan counts the drafts above,
              so a run that planned eight and wrote seven has one still to come,
              not eight. */}
          <strong>On your calendar:</strong> {planned.length} {planned.length === 1 ? "article" : "articles"} over
          the next 30 days, {planned[0].date === planned[planned.length - 1].date ? "on" : "from"}{" "}
          {calendarDay(planned[0].date)}
          {planned[0].date === planned[planned.length - 1].date ? "" : ` to ${calendarDay(planned[planned.length - 1].date)}`}.
          {drafts.length < planned.length
            ? ` ${planned.length - drafts.length} of them still to write; the schedule starts when the trial does.`
            : " The schedule keeps writing after these once the trial starts."}
        </p>
      )}

      {drafts.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between">
            <div className="text-[11px] uppercase tracking-wide text-ink-3">Written for you</div>
            {words > 0 && <div className="text-[11px] text-ink-3">{words.toLocaleString("en-US")} words</div>}
          </div>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-baseline justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium">{d.title || d.keyword}</div>
                  <div className="truncate text-[12px] text-ink-3">
                    {d.keyword}
                    {d.wordCount > 0 ? ` · ${d.wordCount.toLocaleString("en-US")} words` : ""}
                  </div>
                </div>
                <div className={`shrink-0 text-[11.5px] ${VERDICT_LABEL[d.verdict].className}`}>
                  {VERDICT_LABEL[d.verdict].text}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The finish: the pipeline, live, with the deferred setup offered as things to
 * do while it runs. Nothing here is a gate. The person is already invested and
 * the value is already being produced; the ask is framed as improving a result.
 */
function RunScreen({
  workspaceId,
  domain,
  weeklyLimit,
  freeDrafts,
  trialEligible,
  initialRun,
}: {
  workspaceId: string;
  domain: string;
  weeklyLimit: number;
  freeDrafts: number | null;
  trialEligible: boolean;
  initialRun: OnboardingRunSnapshot | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState | null>(null);
  // Bumped by "Try again". `OnboardingProgress` starts a run on mount and
  // never again, so a retry is a remount with no run to resume: the mount
  // effect POSTs /start, which creates a fresh row (the last one is finished)
  // and polls it. Nothing on the old attempt is touched - its phases are on
  // their own tables and its row keeps its status.
  const [attempt, setAttempt] = useState(0);
  const finished = Boolean(state && (state.ready || state.error));
  const planned = state?.planned ?? [];
  // Where "Finish" actually leads, decided by what the run produced. It used
  // to read "Open my plan" and push /content on any terminal state, so a run
  // that scheduled nothing offered a button to an empty calendar.
  const outcome = state ? onboardingOutcome(state) : null;
  const draft = state?.article ?? null;
  const drafts = state?.drafts ?? [];
  // The last step of onboarding: the drafts exist, the person can see what
  // was written for them and what is scheduled, and the card is asked now,
  // before the dashboard. Only for an account that may still trial, and only
  // when the run produced something to show; a run that wrote nothing has
  // no appetizer and falls through to the plain finish.
  const trialStep = finished && trialEligible && (drafts.length > 0 || planned.length > 0);
  const next = planned.length > 0
    ? { href: "/content", label: "Open my plan" }
    : draft
      ? { href: "/review", label: "Open my first draft" }
      : { href: "/dashboard", label: "Open the dashboard" };
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[860px] px-6 py-10">
        <div className="mb-8 text-center">
          <h1 className="mb-1.5 text-[22px] font-semibold">
            {trialStep
              ? `${drafts.length === 1 ? "Your first draft is" : `Your first ${drafts.length} drafts are`} written`
              : finished
                ? "Your content plan"
                : "Creating your content plan"}
          </h1>
          <p className="mx-auto max-w-[520px] text-[13.5px] leading-[1.6] text-ink-2">
            {trialStep ? (
              <>
                Each one comes with its fact check and is waiting in your review queue. Start the trial to
                approve and publish them, and to keep the schedule below writing.
              </>
            ) : (
              <>
                Reading {domain}, choosing keywords by volume, difficulty and fit, scheduling up to{" "}
                {weeklyLimit >= 7 ? "one article a day" : `${weeklyLimit} a week`} for the next 30 days, and writing
                the first one. Only keywords that pass our checks make the plan, so a new site may get fewer.{" "}
                {freeAllowanceClause(freeDrafts) ?? ""}
              </>
            )}
            {/* True since the run left the browser's request: it is a row
                advanced by its own invocations (/api/onboard/run, then
                /api/internal/draft), and this screen only polls it. An
                earlier version said "keep this tab open", because the SSE
                route stopped the pipeline when the tab went. Gone once the
                run is over, because a screen that has said "Done." has no
                wait left to describe. */}
            {!finished && (
              <>
                {" "}
                A few minutes. You can leave this page and come back: the run carries on without you, and this
                screen picks up where it is.
              </>
            )}
          </p>
        </div>

        {trialStep && (
          <TrialStep drafts={drafts} planned={planned} returnTo="/articles?status=review" />
        )}

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
                <ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">
                  {planned.slice(0, 10).map((p) => (
                    <li key={p.date + p.term} className="flex items-baseline gap-2 text-[12.5px]">
                      <span className="font-mono text-[11px] text-ink-3">{p.date.slice(5)}</span>
                      <span className="truncate">{p.term}</span>
                    </li>
                  ))}
                </ul>
                {planned.length > 10 && <p className="m-0 mt-1.5 text-[12px] text-ink-3">and {planned.length - 10} more on the calendar.</p>}
              </div>
            )}
            <div className="mt-6 flex items-center gap-3">
              {/* A plain navigation, live or not. This used to open a new tab
                  while the run was live, because unmounting the progress
                  component aborted the SSE request and the pipeline with it;
                  the run is its own invocations now and nothing on this page
                  can cancel it. Coming back to /onboarding resumes the screen. */}
              {trialStep ? null : finished ? (
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
                      not a job to hand the person. The old text only said
                      "add a keyword by hand", which is the last resort, not
                      the first. */}
                  Nothing was set up yet. Trying again is free to try; if the site still cannot be read,
                  add a keyword by hand from Keywords or connect Search Console and the plan can be built
                  from there.
                </p>
                <Button
                  size="sm"
                  onClick={() => {
                    setState(null);
                    setAttempt((a) => a + 1);
                  }}
                >
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
