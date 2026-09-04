"use client";

// ---------------------------------------------------------------------------
// The onboarding wizard
// ---------------------------------------------------------------------------
//
// Five steps over one idea: the site is read first, and every screen after that
// is verification rather than authorship. Chips arrive filled, the description
// arrives written, and the person deletes what is wrong.
//
// Two deliberate choices, both from watching how this goes wrong:
//
// 1. The CMS step is LAST and its button says Skip. Asking for a credential
//    before anything has been produced is asking someone to prove they own a
//    site before they have seen a reason to care.
// 2. Nothing here blocks on the model. If the profile could not be inferred the
//    fields are simply empty and the wizard still completes.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import { proposeProfile, saveProfile, completeWizard } from "@/app/actions/onboarding-wizard";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { IntegrationIcon } from "@/components/dashboard/integration-icon";

const STEPS = ["Business", "Audience & Competitors", "Blog", "Articles", "Integration"] as const;
type StepIndex = 0 | 1 | 2 | 3 | 4;

export type Destination = { id: string; name: string; description: string | null };

export function OnboardingWizard({
  workspaceId,
  domain,
  initialProfile,
  destinations,
}: {
  workspaceId: string;
  domain: string;
  initialProfile: BusinessProfile | null;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<StepIndex>(0);
  const [profile, setProfile] = useState<BusinessProfile | null>(initialProfile);
  // Null profile and not yet asked = we are about to read the site.
  const [reading, setReading] = useState(initialProfile === null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!reading) return;
    let cancelled = false;
    proposeProfile(workspaceId)
      .then((p) => {
        if (cancelled) return;
        // A null profile is a normal outcome, not an error: empty fields.
        setProfile(p ?? { name: "", language: "English", country: "Global (English)", description: "", audiences: [], competitors: [] });
      })
      .catch(() => {
        if (!cancelled) setProfile({ name: "", language: "English", country: "Global (English)", description: "", audiences: [], competitors: [] });
      })
      .finally(() => !cancelled && setReading(false));
    return () => { cancelled = true; };
  }, [reading, workspaceId]);

  function patch(next: Partial<BusinessProfile>) {
    setProfile((p) => (p ? { ...p, ...next } : p));
  }

  function next() {
    if (step === 4) return finish();
    if (step === 0 && profile) start(() => void saveProfile(workspaceId, profile));
    setStep((s) => (s + 1) as StepIndex);
  }

  function finish() {
    start(async () => {
      if (profile) await saveProfile(workspaceId, profile);
      await completeWizard(workspaceId);
      router.push("/dashboard");
    });
  }

  if (reading || !profile) return <ReadingSite domain={domain} />;

  return (
    <div className="min-h-screen bg-bg">
      <Stepper current={step} />

      <div className="mx-auto max-w-[720px] px-6 pb-28 pt-8">
        {step === 0 && <BusinessStep profile={profile} patch={patch} />}
        {step === 1 && <AudienceStep profile={profile} patch={patch} />}
        {step === 2 && <BlogStep domain={domain} />}
        {step === 3 && <ArticlesStep />}
        {step === 4 && <IntegrationStep destinations={destinations} />}
      </div>

      {/* The bar is fixed because the Articles step is long and a Continue you
          have to scroll for reads as a dead end. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-[720px] items-center justify-between px-6 py-3">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1) as StepIndex)}
            disabled={step === 0 || pending}
          >
            Back
          </Button>
          <Button variant="accent" onClick={next} disabled={pending}>
            {pending ? "Saving…" : step === 4 ? "Skip for now" : "Continue"}
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

/**
 * The wait, with the work named.
 *
 * The cards are the steps this wizard defers - they are what the person could
 * usefully do next, offered while something is already happening rather than as
 * a gate in front of it.
 */
function ReadingSite({ domain }: { domain: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-[560px] text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink-2">
          <Icons.sparkle size={13} />
          Reading {domain}…
        </div>
        <h1 className="mb-2 text-[22px] font-semibold">Setting up your site</h1>
        <p className="mx-auto max-w-[420px] text-[13.5px] leading-[1.6] text-ink-2">
          We read your homepage to fill in what we can, so the next few screens are
          a check rather than a form. It takes about a minute.
        </p>
      </div>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
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

function BusinessStep({
  profile,
  patch,
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
}) {
  return (
    <>
      <Head
        title="About your business"
        sub="Based on your website, we've filled this in. Check it and correct anything wrong."
      />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <Field label="Business name">
          <input className={inputClass} value={profile.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Language">
            <input className={inputClass} value={profile.language} onChange={(e) => patch({ language: e.target.value })} />
          </Field>
          <Field label="Market" hint="Where your search demand is. Global is the broadest signal.">
            <input className={inputClass} value={profile.country} onChange={(e) => patch({ country: e.target.value })} />
          </Field>
        </div>
        <Field label="Description" hint="Used to keep drafts about your actual business rather than the category.">
          <textarea
            rows={7}
            className={`${inputClass} resize-none leading-[1.6]`}
            value={profile.description}
            onChange={(e) => patch({ description: e.target.value })}
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
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v || items.includes(v)) return;
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
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add}>Add</Button>
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

function AudienceStep({
  profile,
  patch,
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
}) {
  return (
    <>
      <Head
        title="Who you sell to, and who you sell against"
        sub="These steer which keywords are worth writing for. Remove anything that is not you."
      />
      <div className="mb-4 rounded-[10px] border border-line bg-panel p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Target audiences</h2>
          <span className="font-mono text-[11px] text-ink-3">{profile.audiences.length}</span>
        </div>
        <ChipList
          items={profile.audiences}
          onChange={(audiences) => patch({ audiences })}
          placeholder="e.g. Content managers at B2B SaaS companies"
        />
      </div>
      <div className="rounded-[10px] border border-line bg-panel p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Competitors</h2>
          <span className="font-mono text-[11px] text-ink-3">{profile.competitors.length}</span>
        </div>
        <ChipList
          items={profile.competitors}
          onChange={(competitors) => patch({ competitors })}
          placeholder="e.g. competitor.com"
        />
      </div>
    </>
  );
}

function BlogStep({ domain }: { domain: string }) {
  return (
    <>
      <Head title="Where your content lives" sub="We found these on your site. Correct them if they are wrong." />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <Field label="Sitemap">
          <input className={inputClass} defaultValue={`https://${domain}/sitemap.xml`} />
        </Field>
        <Field label="Blog address" hint="Where published articles will appear.">
          <input className={inputClass} defaultValue={`https://${domain}/blog/`} />
        </Field>
        <div className="flex items-center justify-between rounded-[8px] border border-line bg-bg px-4 py-3">
          <div>
            <div className="text-[13px] font-medium">Connect Search Console</div>
            <div className="text-[12px] text-ink-3">
              So we skip keywords you already rank for, and can show real clicks later.
            </div>
          </div>
          <a href="/connect/google">
            <Button size="sm">Connect</Button>
          </a>
        </div>
      </div>
    </>
  );
}

function ArticlesStep() {
  return (
    <>
      <Head title="How your articles should read" sub="Set once. Every draft follows these until you change them." />
      <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-panel p-5">
        <div className="flex items-start justify-between gap-6 rounded-[8px] border border-line bg-bg px-4 py-3">
          <div>
            <div className="text-[13px] font-medium">Every draft waits for your yes</div>
            <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
              Articles land in review and publish only when you approve them. This is not a
              setting you can turn off, and it is the difference between a tool and a firehose.
            </div>
          </div>
          <span className="mt-0.5 shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-2">
            ALWAYS ON
          </span>
        </div>
        <Field label="Internal links per article">
          <select className={inputClass} defaultValue="3">
            <option value="2">2 links</option>
            <option value="3">3 links</option>
            <option value="5">5 links</option>
          </select>
        </Field>
        <Field
          label="Anything drafts should always do"
          hint="Optional. Brand voice is learned from your published writing; this is for rules that writing cannot show."
        >
          <textarea rows={3} className={`${inputClass} resize-none`} placeholder="e.g. never claim we are the cheapest" />
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
        sub="You can do this later — drafts are yours either way, and you can export any article as Markdown."
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
        On Next.js, Astro, Hugo or Jekyll? <strong className="font-medium text-ink-2">Git / static site</strong>{" "}
        commits Markdown to your repo and lets your own build deploy it.
      </p>
    </>
  );
}
