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
// even on "Skip setup" because a skipped wizard is the one place a referrer
// tells us nothing, and one click is not a wall.

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
import { saveAttribution } from "@/app/actions/attribution";
import { AttributionPicker, EMPTY_ATTRIBUTION, attributionComplete, type AttributionDraft } from "@/components/onboarding/attribution-picker";
import { TONES, TONE_LABELS, type OutputSettings, type SiteDetails } from "@/lib/onboarding/output-settings";
import type { BusinessProfile, InferenceReason } from "@/lib/onboarding/business-profile";
import type { SiteDiscovery } from "@/lib/onboarding/site-discovery";
import { LANGUAGE_OPTIONS, MARKET_OPTIONS, GLOBAL_MARKET } from "@/lib/onboarding/locale";
import { IntegrationIcon } from "@/components/dashboard/integration-icon";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import type { OnboardingState } from "@/lib/onboarding/events";

const SITE_STEPS = ["Business", "Audience & Competitors", "Blog", "Articles", "Integration"];
// The question about the person, after every step about the site. Present only
// while the account has not answered; a second workspace goes straight to plan.
const ATTRIBUTION_STEP = SITE_STEPS.length;

export type Destination = { id: string; name: string; description: string | null };

const EMPTY_PROFILE: BusinessProfile = {
  name: "",
  language: "English",
  country: GLOBAL_MARKET,
  description: "",
  audiences: [],
  competitors: [],
};


export function OnboardingWizard({
  workspaceId,
  domain,
  weeklyLimit,
  initialProfile,
  initialSite,
  initialOutput,
  destinations,
  askAttribution,
}: {
  workspaceId: string;
  domain: string;
  weeklyLimit: number;
  initialProfile: BusinessProfile | null;
  initialSite: SiteDetails;
  initialOutput: OutputSettings;
  destinations: Destination[];
  askAttribution: boolean;
}) {
  const router = useRouter();
  const steps = askAttribution ? [...SITE_STEPS, "About you"] : SITE_STEPS;
  const last = steps.length - 1;
  const [step, setStep] = useState(0);
  const [attribution, setAttribution] = useState<AttributionDraft>(EMPTY_ATTRIBUTION);
  // Set when "Skip setup" was pressed: which screen it was pressed on, so Back
  // returns there, and the finish goes to the dashboard rather than to a plan.
  const [skipFrom, setSkipFrom] = useState<number | null>(null);
  const skipping = skipFrom !== null;
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
  async function persist(s: number) {
    if ((s === 0 || s === 1) && profile) await saveProfile(workspaceId, profile);
    if (s === 2) await saveSiteDetails(workspaceId, site);
    if (s === 3) await saveOutputSettings(workspaceId, output);
    if (s === ATTRIBUTION_STEP && attribution.source) await saveAttribution(attribution.source, attribution.note);
  }

  function next() {
    setError(null);
    start(async () => {
      try {
        await persist(step);
        if (step !== last) {
          setStep(step + 1);
        } else if (skipping) {
          if (profile) await saveProfile(workspaceId, profile);
          await completeWizard(workspaceId, { skipped: true });
          router.push("/dashboard");
        } else {
          await completeWizard(workspaceId);
          setRunning(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save this step.");
      }
    });
  }

  function skipAll() {
    // Skipping the site setup still passes through the one question that is
    // about the person. It is answered with a click and finished from there.
    if (askAttribution) {
      setError(null);
      setSkipFrom(step);
      setStep(ATTRIBUTION_STEP);
      return;
    }
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
      <Stepper steps={steps} current={step} />

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
        {step === 4 && <IntegrationStep destinations={destinations} />}
        {step === ATTRIBUTION_STEP && <AttributionStep value={attribution} onChange={setAttribution} skipping={skipping} />}
        {step === last && !skipping && <NextUp weeklyLimit={weeklyLimit} />}
        {error && <p className="mt-4 rounded-lg bg-err-soft px-3 py-2 text-[12.5px] text-err-ink">{error}</p>}
      </div>

      {/* The bar is fixed because the Articles step is long and a Continue you
          have to scroll for reads as a dead end. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-[720px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => {
                if (skipFrom !== null) {
                  setStep(skipFrom);
                  setSkipFrom(null);
                } else {
                  setStep((s) => Math.max(0, s - 1));
                }
              }}
              disabled={step === 0 || pending}
            >
              Back
            </Button>
            {step !== ATTRIBUTION_STEP && (
              <button
                type="button"
                onClick={skipAll}
                disabled={pending}
                className="text-[12px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink"
              >
                Skip setup
              </button>
            )}
          </div>
          <Button
            variant="accent"
            onClick={next}
            disabled={pending || (step === ATTRIBUTION_STEP && !attributionComplete(attribution))}
          >
            {pending ? "Saving…" : step !== last ? "Continue" : skipping ? "Skip and finish" : "Finish and plan my first month"}
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

const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-ink outline-none focus:border-accent transition-colors";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 rounded-[8px] border border-line bg-bg px-4 py-3">
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-[1.5] text-ink-3">{hint}</span>
      </span>
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
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
  const market = MARKET_OPTIONS.find((m) => m.label === profile.country);
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
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <Field label="Business name">
          <input className={inputClass} value={profile.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Acme" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Language">
            <select
              className={inputClass}
              value={LANGUAGE_OPTIONS.find((o) => o.label.toLowerCase() === profile.language.toLowerCase())?.label ?? profile.language}
              onChange={(e) => patch({ language: e.target.value })}
            >
              {!LANGUAGE_OPTIONS.some((o) => o.label.toLowerCase() === profile.language.toLowerCase()) && (
                <option value={profile.language}>{profile.language}</option>
              )}
              {LANGUAGE_OPTIONS.map((o) => (
                <option key={o.code} value={o.label}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Market" hint={market?.hint ?? "Where your search demand is. Keyword data comes from this country."}>
            <select className={inputClass} value={market ? market.label : GLOBAL_MARKET} onChange={(e) => patch({ country: e.target.value })}>
              {MARKET_OPTIONS.map((m) => (
                <option key={m.label} value={m.label}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Description" hint="Used to keep drafts about your actual business rather than the category.">
          <textarea
            rows={7}
            className={`${inputClass} resize-none leading-[1.6]`}
            value={profile.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="What you sell, to whom, and what sets it apart."
          />
        </Field>
      </div>
    </>
  );
}

/** Removable chips with an add box. Deleting is the main verb here. */
function ChipList({
  items,
  onChange,
  placeholder,
  max,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  max: number;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v || items.includes(v) || items.length >= max) return;
    onChange([...items, v]);
    setDraft("");
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder={placeholder}
          value={draft}
          disabled={items.length >= max}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} disabled={items.length >= max}>
          Add
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item} className="flex items-start gap-2 rounded-[8px] border border-line bg-bg px-3 py-2">
            <span className="flex-1 text-[12.5px] leading-[1.5]">{item}</span>
            <button
              type="button"
              aria-label={`Remove ${item}`}
              className="mt-0.5 cursor-pointer text-ink-3 hover:text-ink"
              onClick={() => onChange(items.filter((i) => i !== item))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
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
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Target audiences</h2>
          <span className="font-mono text-[11px] text-ink-3">{profile.audiences.length}/7</span>
        </div>
        <ChipList
          items={profile.audiences}
          onChange={(audiences) => patch({ audiences })}
          placeholder="e.g. Content managers at B2B SaaS companies"
          max={7}
        />
      </div>
      <div className="rounded-[10px] border border-line bg-panel p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Competitors</h2>
          <span className="font-mono text-[11px] text-ink-3">{profile.competitors.length}/7</span>
        </div>
        <ChipList
          items={profile.competitors}
          onChange={(competitors) => patch({ competitors: competitors.map((c) => c.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()) })}
          placeholder="e.g. competitor.com"
          max={7}
        />
        <p className="mt-2 text-[11.5px] text-ink-3">Domains, not names. Bigger competitors give more keyword ideas.</p>
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
  const examples = [0, 1, 2].map((i) => site.exampleArticleUrls[i] ?? "");
  return (
    <>
      <Head title="Where your content lives" sub={sub} />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <Field label="Sitemap" hint="Used to find your existing pages for internal links.">
          <input
            className={inputClass}
            value={site.sitemapUrl}
            placeholder={`https://${domain}/sitemap.xml`}
            onChange={(e) => setSite({ ...site, sitemapUrl: e.target.value })}
          />
        </Field>
        <Field label="Blog address" hint="Where published articles will appear.">
          <input
            className={inputClass}
            value={site.blogRootUrl}
            placeholder={`https://${domain}/blog/`}
            onChange={(e) => setSite({ ...site, blogRootUrl: e.target.value })}
          />
        </Field>
        <Field label="Your best writing" hint="Up to three articles you are proud of. Drafts learn their voice from these before anything else.">
          <div className="flex flex-col gap-2">
            {examples.map((v, i) => (
              <input
                key={i}
                className={inputClass}
                value={v}
                placeholder={i === 0 ? `https://${domain}/blog/an-article-you-like` : "https://…"}
                onChange={(e) => {
                  const next = [...examples];
                  next[i] = e.target.value;
                  setSite({ ...site, exampleArticleUrls: next.filter(Boolean) });
                }}
              />
            ))}
          </div>
        </Field>
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
  const set = (p: Partial<OutputSettings>) => setOutput({ ...output, ...p });
  return (
    <>
      <Head title="How your articles should read" sub="Set once. Every draft follows these until you change them in Settings." />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <div className="flex items-start justify-between gap-6 rounded-[8px] border border-line bg-bg px-4 py-3">
          <div>
            <div className="text-[13px] font-medium">Every draft waits for your yes</div>
            <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
              Articles land in review and publish only when you approve them. This is not a setting you can turn
              off, and it is the difference between a tool and a firehose.
            </div>
          </div>
          <span className="mt-0.5 shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-2">
            ALWAYS ON
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Tone" hint="The default voice. Brand voice learned from your writing refines it.">
            <select className={inputClass} value={output.tone} onChange={(e) => set({ tone: e.target.value as OutputSettings["tone"] })}>
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {TONE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Internal links per article">
            <select className={inputClass} value={String(output.internalLinks)} onChange={(e) => set({ internalLinks: Number(e.target.value) })}>
              {[0, 2, 3, 5, 8].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "None" : `${n} links`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Toggle
          label="Table of contents"
          hint="Added from the heading structure of each article."
          checked={output.tableOfContents}
          onChange={(v) => set({ tableOfContents: v })}
        />
        <Toggle
          label="Call to action"
          hint="A closing section that points readers at your site."
          checked={output.callToAction}
          onChange={(v) => set({ callToAction: v })}
        />
        <Toggle
          label="First-person writing"
          hint='Allows "we" and "our" when it reads naturally. Off means third person only.'
          checked={output.firstPerson}
          onChange={(v) => set({ firstPerson: v })}
        />
        <Toggle
          label="Mention similar products"
          hint="Compare and reference alternatives where relevant. Off keeps articles to your own category."
          checked={output.mentionSimilarProducts}
          onChange={(v) => set({ mentionSimilarProducts: v })}
        />
        <Field
          label="Anything drafts should always do"
          hint="Optional. Brand voice is learned from your published writing; this is for rules that writing cannot show. Most sites leave it empty."
        >
          <textarea
            rows={3}
            className={`${inputClass} resize-none`}
            placeholder="e.g. never claim we are the cheapest; always mention the free tier"
            value={output.globalArticlePrompt}
            onChange={(e) => set({ globalArticlePrompt: e.target.value })}
          />
        </Field>
      </div>
    </>
  );
}

function IntegrationStep({ destinations }: { destinations: Destination[] }) {
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
    </>
  );
}

/** What Finish does, under whichever screen is last. */
function NextUp({ weeklyLimit }: { weeklyLimit: number }) {
  return (
    <p className="mt-6 text-center text-[12.5px] leading-[1.6] text-ink-2">
      Next: we read your site properly, find what to write about, schedule{" "}
      <strong className="font-medium text-ink">
        {weeklyLimit >= 7 ? "one article a day" : `${weeklyLimit} article${weeklyLimit === 1 ? "" : "s"} a week`}
      </strong>{" "}
      for the next 30 days, and write the first one. Every draft waits in review.
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
  skipping,
}: {
  value: AttributionDraft;
  onChange: (v: AttributionDraft) => void;
  skipping: boolean;
}) {
  return (
    <>
      <Head
        title={skipping ? "One thing before you go" : "One last thing"}
        sub="How did you hear about us? Pick the closest. It is the only way we can tell whether an AI answer sent you here, which is the thing we sell."
      />
      <div className="rounded-[10px] border border-line bg-panel p-5">
        <AttributionPicker value={value} onChange={onChange} />
      </div>
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
