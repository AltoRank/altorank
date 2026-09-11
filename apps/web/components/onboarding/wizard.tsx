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
  saveProfile,
  discoverSiteDetails,
  saveSiteDetails,
  completeWizard,
} from "@/app/actions/onboarding-wizard";
import { saveAttribution } from "@/app/actions/attribution";
import { AttributionPicker, EMPTY_ATTRIBUTION, attributionComplete, type AttributionDraft } from "@/components/onboarding/attribution-picker";
import type { SiteDetails } from "@/lib/onboarding/output-settings";
import { EMPTY_PROFILE, type BusinessProfile, type InferenceReason } from "@/lib/onboarding/business-profile";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
// The forms themselves live in components/settings: every wizard screen is
// also a permanent Settings tab, and one copy of each form keeps them in step.
import { BusinessFields } from "@/components/settings/business-fields";
import { AudienceList, CompetitorList, OfferingList } from "@/components/settings/audience-fields";
import { SiteFields } from "@/components/settings/site-fields";
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
import { worthShowing, type TrafficRange } from "@/lib/onboarding/first-month-outlook";
import { PLAN_PRICES, PLAN_YEARLY_PRICES, type BillingInterval } from "@/lib/stripe";
import { TRIAL_OFFER } from "@/lib/billing/trial";
import posthog from "posthog-js";

export type Destination = { id: string; name: string; description: string | null };

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
  askAttribution,
  alreadyOnboarded = false,
  gatePlan = [],
  gateReport = null,
  gateTraffic = null,
  gateWritten = [],
  initialRun = null,
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
  /** The analysis already run on this account's site, shown open on the gate. */
  gateReport?: FirstLookReport | null;
  /** What the planned month could be worth, as a range. Null when not gated. */
  gateTraffic?: TrafficRange | null;
  /** Articles the run already wrote, matched to the plan by keyword. */
  gateWritten?: { keyword: string; title: string; wordCount: number }[];
  initialRun?: OnboardingRunSnapshot | null;
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

  /**
   * The one button. Saves everything on the screen, marks the wizard done and
   * starts the run. Nothing is saved before this: the five-step version wrote
   * each screen on Continue, so a person who closed the tab on screen three had
   * two screens of half-checked answers on disk and a wizard that reopened on
   * screen one anyway.
   */
  function finish() {
    setError(null);
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
    return <TrialGateScreen domain={domain} planned={gatePlan} report={gateReport} traffic={gateTraffic} written={gateWritten} askAttribution={askAttribution} />;
  }

  if (running) {
    return <RunScreen workspaceId={workspaceId} domain={domain} weeklyLimit={weeklyLimit} freeDrafts={freeDrafts} trialEligible={trialEligible} askAttribution={askAttribution} initialRun={resumed} />;
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
            <CompetitorList profile={profile} patch={patch} />
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
            {freeAllowanceClause(freeDrafts) ? ` ${freeAllowanceClause(freeDrafts)}` : ""}
          </p>
          <Button variant="accent" onClick={finish} disabled={pending || reading}>
            {pending ? "Saving…" : "Plan my first month"}
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

/**
 * The one question about the person, asked once, where it now lives: beside
 * the trial ask. One click saves it; nothing else on the screen waits for it.
 * The copy says why we ask, because a question with no visible reason gets
 * the answer that closes it fastest, and the answer we most need to be true
 * is the one about AI.
 */
function AttributionAsk() {
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
    return <p className="m-0 mt-4 text-[12.5px] text-ink-3">Thanks. That is the one thing we asked about you.</p>;
  }
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="m-0 mb-2.5 text-[12.5px] leading-[1.5] text-ink-2">
        <strong className="font-medium text-ink">Where did you hear about us?</strong> Optional. It is the only way we can
        tell whether an AI answer sent you here, which is the thing we sell.
      </p>
      <AttributionPicker value={value} onChange={onChange} columns={5} />
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
  traffic,
  written,
  askAttribution = false,
}: {
  domain: string;
  planned: OnboardingPlanned[];
  report: FirstLookReport | null;
  traffic: TrafficRange | null;
  written: { keyword: string; title: string; wordCount: number }[];
  askAttribution?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<BillingInterval>("month");
  const words = planned.length;
  const fixable = report?.readiness?.findings.filter((f) => !f.passed && !f.inconclusive).length ?? 0;
  const pagesToFix = report?.existingPages?.withIssues ?? 0;
  const showTraffic = traffic !== null && worthShowing(traffic);
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

        <div className="mx-auto mb-6 max-w-[640px] rounded-[10px] border border-accent/40 bg-panel p-5">
          <div className="rounded-[8px] bg-accent/5 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-wide text-accent">7-day trial</div>

            {/* Two priced choices, not a pair of unlabelled pills. The first
                version showed "Monthly | Yearly" with no amounts, which reads
                as a view switch rather than a decision about money - and the
                whole point of asking before the card is that the person knows
                what the card is for. Amounts come from lib/stripe, the same
                constants the billing page renders, so the two screens cannot
                quote different prices for the same plan. */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              {([
                { id: "month" as const, label: "Monthly", price: PLAN_PRICES.starter, per: "per month", note: null },
                { id: "year" as const, label: "Yearly", price: PLAN_YEARLY_PRICES.starter, per: "per year", note: "2 months free" },
              ]).map((opt) => {
                const on = interval === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setInterval(opt.id)}
                    aria-pressed={on}
                    className={`rounded-[8px] border p-3 text-left transition-colors ${
                      on ? "border-accent bg-accent/10" : "border-line bg-bg hover:border-ink-4"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12.5px] font-medium text-ink">{opt.label}</span>
                      {opt.note && (
                        <span className="rounded-full bg-ok-soft px-1.5 py-px text-[10.5px] text-ok-ink">{opt.note}</span>
                      )}
                    </div>
                    <div className="mt-1 text-[17px] font-semibold leading-none text-ink">{opt.price}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-3">{opt.per}</div>
                  </button>
                );
              })}
            </div>

            <p className="m-0 mb-3 text-[13px] leading-[1.6] text-ink-2">
              {TRIAL_OFFER}
            </p>
            <StartTrialButton returnTo="/dashboard" interval={interval} onError={setError} />
            {error && (
              <p className="m-0 mt-2.5 text-[12.5px] leading-[1.5] text-err-ink" role="alert">
                {error}
              </p>
            )}
          </div>
          {askAttribution && <AttributionAsk />}
        </div>

        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          {(showTraffic || words > 0 || fixable > 0 || pagesToFix > 0) && (
            <div className="rounded-[8px] border border-line bg-bg p-4">
              <div className="mb-2.5 text-[12.5px] font-medium text-ink">What a month of this looks like</div>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[12.5px] text-ink-2">
                {words > 0 && (
                  <li>
                    <strong className="text-ink">{words}</strong> {words === 1 ? "article" : "articles"} written and
                    waiting for your approval
                  </li>
                )}
                {showTraffic && traffic && (
                  <li>
                    <strong className="text-ink">
                      {traffic.low.toLocaleString("en-US")}–{traffic.high.toLocaleString("en-US")}
                    </strong>{" "}
                    organic visits a month <span className="text-ink-3">if these reach page one</span>
                  </li>
                )}
                {fixable > 0 && (
                  <li>
                    <strong className="text-ink">{fixable}</strong> {fixable === 1 ? "thing" : "things"} stopping AI
                    assistants reading {domain || "your site"}, each with the fix
                  </li>
                )}
                {pagesToFix > 0 && (
                  <li>
                    <strong className="text-ink">{pagesToFix}</strong> existing {pagesToFix === 1 ? "page" : "pages"}{" "}
                    with something to fix
                  </li>
                )}
              </ul>
              {showTraffic && traffic && (
                /* The assumption, next to the number that rests on it. A single
                   confident figure here would be the same mistake as the "86
                   failed every check" line that shipped and was false. */
                <p className="m-0 mt-2.5 text-[11.5px] leading-[1.5] text-ink-3">
                  An estimate, not a forecast: search volume for the{" "}
                  {traffic.counted} {traffic.counted === 1 ? "keyword" : "keywords"} planned, against typical
                  click-through at the positions {domain || "this site"} can realistically reach.
                  {traffic.excluded > 0 && ` ${traffic.excluded} left out as out of reach or unmeasured.`}{" "}
                  Ranking takes months, and nothing here is promised.
                </p>
              )}
            </div>
          )}

          {planned.length > 0 && (
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <div className="text-[12.5px] font-medium text-ink">Your first month</div>
                <div className="text-[11.5px] text-ink-3">
                  {planned.length} {planned.length === 1 ? "article" : "articles"} scheduled
                </div>
              </div>
              {/* The first row is the article that exists: its real title, its
                  real length, readable now. Everything under it is locked, and
                  locked is drawn as a lock and not as a spinner - nothing is
                  being written down there. The schedule starts when the trial
                  does, so a progress indicator would be describing work that
                  is not happening. */}
              <ul className="m-0 list-none divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-bg p-0">
                {planned.slice(0, 8).map((p) => {
                  const done = written.find(
                    (w) => w.keyword.trim().toLowerCase() === p.term.trim().toLowerCase(),
                  );
                  return (
                    <li
                      key={`${p.date}-${p.term}`}
                      className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12.5px] ${done ? "" : "opacity-55"}`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="shrink-0 text-ok-ink">
                          {done ? <Icons.check size={13} /> : <Icons.lock size={12} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-ink">{done ? done.title || p.term : p.term}</span>
                          {done && (
                            <span className="block truncate text-[11.5px] text-ink-3">
                              Written{done.wordCount > 0 ? ` · ${done.wordCount.toLocaleString("en-US")} words` : ""} · waiting for your approval
                            </span>
                          )}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{calendarDay(p.date)}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="m-0 mt-2 text-[12px] text-ink-2">
                {written.length > 0
                  ? "The rest are scheduled. They start writing when your trial does."
                  : "These start writing when your trial does."}
              </p>
            </div>
          )}

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
  askAttribution = false,
}: {
  drafts: OnboardingArticle[];
  planned: OnboardingPlanned[];
  returnTo: string;
  askAttribution?: boolean;
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
      {askAttribution && <AttributionAsk />}

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
  askAttribution = false,
  initialRun,
}: {
  workspaceId: string;
  domain: string;
  weeklyLimit: number;
  freeDrafts: number | null;
  trialEligible: boolean;
  askAttribution?: boolean;
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
          <TrialStep drafts={drafts} planned={planned} returnTo="/articles?status=review" askAttribution={askAttribution} />
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
