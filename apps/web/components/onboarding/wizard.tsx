"use client";

// ---------------------------------------------------------------------------
// The onboarding wizard
// ---------------------------------------------------------------------------
//
// Five steps over one idea: the site is read first, and every screen after that
// is verification rather than authorship. Chips arrive filled, the description
// arrives written, and the person deletes what is wrong.
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
// The CMS step is still last and still skippable. A credential before value
// is asking someone to prove they own a site before they have a reason to care.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import {
  proposeProfile,
  saveProfile,
  discoverSiteDetails,
  saveSiteDetails,
  saveOutputSettings,
  completeWizard,
} from "@/app/actions/onboarding-wizard";
import type { OutputSettings, SiteDetails } from "@/lib/onboarding/output-settings";
import { EMPTY_PROFILE, type BusinessProfile, type InferenceReason } from "@/lib/onboarding/business-profile";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
// The forms themselves live in components/settings: every wizard screen is
// also a permanent Settings tab, and one copy of each form keeps them in step.
import { BusinessFields } from "@/components/settings/business-fields";
import { AudienceList, CompetitorList } from "@/components/settings/audience-fields";
import { SiteFields } from "@/components/settings/site-fields";
import { ApprovalGateCard, OutputFields } from "@/components/settings/output-fields";
import { IntegrationIcon } from "@/components/dashboard/integration-icon";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import type { OnboardingState } from "@/lib/onboarding/events";

const STEPS = ["Business", "Audience & Competitors", "Blog", "Articles", "Integration"] as const;
type StepIndex = 0 | 1 | 2 | 3 | 4;

export type Destination = { id: string; name: string; description: string | null };

export function OnboardingWizard({
  workspaceId,
  domain,
  weeklyLimit,
  initialProfile,
  initialSite,
  initialOutput,
  destinations,
}: {
  workspaceId: string;
  domain: string;
  weeklyLimit: number;
  initialProfile: BusinessProfile | null;
  initialSite: SiteDetails;
  initialOutput: OutputSettings;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<StepIndex>(0);
  const [profile, setProfile] = useState<BusinessProfile | null>(initialProfile);
  const [site, setSite] = useState<SiteDetails>(initialSite);
  const [output, setOutput] = useState<OutputSettings>(initialOutput);
  // Null profile and not yet asked = we are about to read the site.
  const [reading, setReading] = useState(initialProfile === null);
  const [readFailure, setReadFailure] = useState<InferenceReason | null>(null);
  const [discovery, setDiscovery] = useState<SiteDiscovery | null | "pending">(initialSite.sitemapUrl || initialSite.blogRootUrl ? null : "pending");
  const [running, setRunning] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Read the site. A failure is a normal outcome and is shown as one.
  useEffect(() => {
    if (!reading) return;
    let cancelled = false;
    proposeProfile(workspaceId)
      .then((r) => {
        if (cancelled) return;
        setProfile(r.profile ?? EMPTY_PROFILE);
        setReadFailure(r.profile ? null : r.reason);
      })
      .catch(() => {
        if (cancelled) return;
        setProfile(EMPTY_PROFILE);
        setReadFailure("model_failed");
      })
      .finally(() => !cancelled && setReading(false));
    return () => {
      cancelled = true;
    };
  }, [reading, workspaceId]);

  // Look for the sitemap and blog in the background while step 1 is on screen,
  // so step 3 opens with an answer rather than a spinner.
  useEffect(() => {
    if (discovery !== "pending") return;
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
  }, [discovery, workspaceId]);

  function patch(next: Partial<BusinessProfile>) {
    setProfile((p) => (p ? { ...p, ...next } : p));
  }

  /** Persist the screen being left. Each step owns one save. */
  async function persist(s: StepIndex) {
    if ((s === 0 || s === 1) && profile) await saveProfile(workspaceId, profile);
    if (s === 2) await saveSiteDetails(workspaceId, site);
    if (s === 3) await saveOutputSettings(workspaceId, output);
  }

  function next() {
    setError(null);
    start(async () => {
      try {
        await persist(step);
        if (step === 4) {
          await completeWizard(workspaceId);
          setRunning(true);
        } else {
          setStep((s) => (s + 1) as StepIndex);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save this step.");
      }
    });
  }

  function skipAll() {
    start(async () => {
      try {
        if (profile) await saveProfile(workspaceId, profile);
        await completeWizard(workspaceId, { skipped: true });
        router.push("/dashboard");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not skip.");
      }
    });
  }

  if (running) {
    return <RunScreen workspaceId={workspaceId} domain={domain} weeklyLimit={weeklyLimit} />;
  }

  if (reading || !profile) return <ReadingSite domain={domain} />;

  return (
    <div className="min-h-screen bg-bg">
      <Stepper current={step} />

      <div className="mx-auto max-w-[720px] px-6 pb-28 pt-8">
        {step === 0 && (
          <BusinessStep
            profile={profile}
            patch={patch}
            domain={domain}
            failure={readFailure}
            onRetry={() => {
              setReadFailure(null);
              setReading(true);
            }}
          />
        )}
        {step === 1 && <AudienceStep profile={profile} patch={patch} />}
        {step === 2 && <BlogStep site={site} setSite={setSite} discovery={discovery} domain={domain} />}
        {step === 3 && <ArticlesStep output={output} setOutput={setOutput} />}
        {step === 4 && <IntegrationStep destinations={destinations} weeklyLimit={weeklyLimit} />}
        {error && <p className="mt-4 rounded-lg bg-err-soft px-3 py-2 text-[12.5px] text-err-ink">{error}</p>}
      </div>

      {/* The bar is fixed because the Articles step is long and a Continue you
          have to scroll for reads as a dead end. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-[720px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => setStep((s) => Math.max(0, s - 1) as StepIndex)}
              disabled={step === 0 || pending}
            >
              Back
            </Button>
            <button
              type="button"
              onClick={skipAll}
              disabled={pending}
              className="text-[12px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink"
            >
              Skip setup
            </button>
          </div>
          <Button variant="accent" onClick={next} disabled={pending}>
            {pending ? "Saving…" : step === 4 ? "Finish and plan my first month" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <div className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-[860px] items-center gap-2 overflow-x-auto px-6 py-4">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2 whitespace-nowrap">
            <span
              className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
                i < current ? "bg-accent text-bg" : i === current ? "border-2 border-accent" : "border border-line"
              }`}
            >
              {i < current ? "✓" : ""}
            </span>
            <span className={`text-[12.5px] ${i <= current ? "text-ink" : "text-ink-3"}`}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-line" />}
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
};

function BusinessStep({
  profile,
  patch,
  domain,
  failure,
  onRetry,
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
  domain: string;
  failure: InferenceReason | null;
  onRetry: () => void;
}) {
  return (
    <>
      <Head
        title="About your business"
        sub={
          failure
            ? `We could not fill this in from ${domain}.`
            : "Based on your website, we've filled this in. Check it and correct anything wrong."
        }
      />
      {failure && (
        <div className="mb-4 flex items-start justify-between gap-4 rounded-[10px] border border-line bg-panel p-4">
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink-2">{FAILURE_COPY[failure]}</p>
          {failure !== "no_model" && (
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
        title="Who you sell to, and who you sell against"
        sub="These steer which keywords are worth writing for, and every keyword remembers which of them it came from. Remove anything that is not you."
      />
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
          <a href="/connect/google">
            <Button size="sm">Connect</Button>
          </a>
        </div>
      </div>
    </>
  );
}

function ArticlesStep({ output, setOutput }: { output: OutputSettings; setOutput: (o: OutputSettings) => void }) {
  return (
    <>
      <Head title="How your articles should read" sub="Set once. Every draft follows these until you change them in Settings." />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <ApprovalGateCard />
        <OutputFields output={output} setOutput={setOutput} />
      </div>
    </>
  );
}

function IntegrationStep({ destinations, weeklyLimit }: { destinations: Destination[]; weeklyLimit: number }) {
  return (
    <>
      <Head
        title="Where should we publish?"
        sub="You can do this later. Drafts are yours either way, and you can export any article as Markdown."
      />
      <div className="grid grid-cols-3 gap-3">
        {destinations.map((d) => (
          <a
            key={d.id}
            href={`/connect?connect=${d.id}`}
            title={d.description ?? undefined}
            className="flex flex-col items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-5 text-center transition-colors hover:border-accent"
          >
            <IntegrationIcon id={d.id} name={d.name} size={30} />
            <span className="text-[12px] leading-[1.35]">{d.name}</span>
          </a>
        ))}
      </div>
      {/* Named rather than left to the grid: a static site has no CMS to pick,
          and someone on Next.js or Astro will otherwise read this screen as
          "not supported" and skip a destination we do have. */}
      <p className="mt-4 text-center text-[12px] leading-[1.6] text-ink-3">
        On Next.js, Astro, Hugo or Jekyll? <strong className="font-medium text-ink-2">Git / static site</strong> commits
        Markdown to your repo and lets your own build deploy it.
      </p>
      <p className="mt-6 text-center text-[12.5px] leading-[1.6] text-ink-2">
        Next: we read your site properly, find what to write about, schedule{" "}
        <strong className="font-medium text-ink">
          {weeklyLimit >= 7 ? "one article a day" : `${weeklyLimit} article${weeklyLimit === 1 ? "" : "s"} a week`}
        </strong>{" "}
        for the next 30 days, and write the first one. Every draft waits in review.
      </p>
    </>
  );
}

/**
 * The finish: the pipeline, live, with the deferred setup offered as things to
 * do while it runs. Nothing here is a gate. The person is already invested and
 * the value is already being produced; the ask is framed as improving a result.
 */
function RunScreen({ workspaceId, domain, weeklyLimit }: { workspaceId: string; domain: string; weeklyLimit: number }) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState | null>(null);
  const finished = Boolean(state && (state.ready || state.error));
  const planned = state?.planned ?? [];
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[860px] px-6 py-10">
        <div className="mb-8 text-center">
          <h1 className="mb-1.5 text-[22px] font-semibold">Creating your content plan</h1>
          <p className="mx-auto max-w-[520px] text-[13.5px] leading-[1.6] text-ink-2">
            Reading {domain}, choosing keywords by volume, difficulty and fit, scheduling{" "}
            {weeklyLimit >= 7 ? "one article a day" : `${weeklyLimit} a week`} for the next 30 days, and writing the
            first one. A few minutes. You can leave this page; we keep working.
          </p>
        </div>

        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className="rounded-[10px] border border-line bg-panel p-5">
            <OnboardingProgress workspaceId={workspaceId} domain={domain} autoNavigate={false} onState={setState} />
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
              <Button variant="accent" onClick={() => router.push("/content")} disabled={!finished && planned.length === 0}>
                {finished ? "Open my plan" : "Open the calendar so far"}
              </Button>
              {!finished && <span className="text-[12px] text-ink-3">Still working…</span>}
            </div>
          </div>

          <aside className="flex flex-col gap-3">
            <div className="text-[11px] uppercase tracking-wide text-ink-3">While you wait</div>
            <WaitCard
              href="/connect"
              title="Connect your CMS"
              sub="Approved articles publish to your site. Without it they stay drafts you export by hand."
              icon={<Icons.link size={14} />}
            />
            <WaitCard
              href="/connect/google"
              title="Connect Search Console"
              sub="Sharpens keyword research with what you already rank for, and shows real clicks."
              icon={<Icons.trend size={14} />}
            />
            <WaitCard
              href="/voice"
              title="Review your brand voice"
              sub="See what we learned from your writing and correct it."
              icon={<Icons.sparkle size={14} />}
            />
            <WaitCard
              href="/review"
              title="How review works"
              sub="Every draft waits for your approval. Nothing publishes on its own."
              icon={<Icons.check size={14} />}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function WaitCard({ href, title, sub, icon }: { href: string; title: string; sub: string; icon: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-start gap-3 rounded-[10px] border border-line bg-panel px-4 py-3 transition-colors hover:border-accent"
    >
      <span className="mt-0.5 text-ink-2">{icon}</span>
      <span>
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-[1.5] text-ink-3">{sub}</span>
      </span>
    </a>
  );
}
