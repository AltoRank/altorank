"use client";

// ---------------------------------------------------------------------------
// What we understood: the site read, beside the run it started
// ---------------------------------------------------------------------------
//
// The check screen used to stand between the site read and the run: a form of
// five sections and one button, "Write my first article", and it was the
// screen people left on. Now the run starts as soon as the read lands
// (wizard.tsx, `autoStart`), and what the read found is shown here, beside the
// run, as the facts it is building on. It is not edited here: the run
// already under way is built on it, and /api/onboard/start would hand back
// that run rather than start another. The form, and the one free re-run the
// spend gate allows before the trial, are offered once the run has ended.

import type { BusinessProfile } from "@/lib/onboarding/profile-shape";
import { businessLine, localeLine } from "@/lib/onboarding/wizard-rules";

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="m-0 text-[12.5px] text-ink-3">{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {items.map((item) => (
        <li key={item} className="rounded-full border border-line bg-panel px-2.5 py-1 text-[12.5px] leading-tight text-ink">
          {item}
        </li>
      ))}
    </ul>
  );
}

function Row({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`flex flex-col gap-1.5 px-3.5 py-3 ${last ? "" : "border-b border-line-soft"}`}>
      <div className="text-[11.5px] text-ink-3">{label}</div>
      {children}
    </div>
  );
}

export function WhatWeUnderstood({ profile, domain }: { profile: BusinessProfile; domain: string }) {
  const offerings = (profile.offerings ?? []).filter((o) => o.trim());
  const rivals = [...profile.competitors, ...(profile.competitorNames ?? [])].filter((r) => r.trim());
  return (
    <section aria-labelledby="understood-heading" className="flex flex-col rounded-[10px] border border-line bg-panel">
      <div className="px-4 pb-2.5 pt-3.5">
        <h2 id="understood-heading" className="m-0 text-[14px] font-semibold text-ink">
          What we understood
        </h2>
        <p className="m-0 mt-0.5 text-[12.5px] leading-[1.5] text-ink-3">From {domain || "your site"}. Your first article is built on this.</p>
      </div>
      <div className="mx-2.5 mb-2.5 flex flex-col rounded-[8px] border border-line bg-bg">
        <Row label="Business">
          {/* The whole description, clamped by CSS with a real ellipsis:
              businessLine's first-sentence cut stops at 140 characters
              mid-word, which read as "...can read your si" on altorank.co. */}
          <p className="m-0 line-clamp-4 text-[13px] leading-[1.5] text-ink" title={profile.description.trim() || undefined}>
            {profile.description.trim() || businessLine(profile) || "Not read yet"}
          </p>
        </Row>
        <Row label="What you sell">
          <Chips items={offerings.slice(0, 6)} empty="Read from your description" />
        </Row>
        <Row label="Who buys">
          <Chips items={profile.audiences.slice(0, 4)} empty="Not found on the site" />
        </Row>
        <Row label="Language and market">
          <p className="m-0 text-[13px] text-ink">{localeLine(profile)}</p>
        </Row>
        <Row label="Rivals in your searches" last>
          <Chips items={rivals.slice(0, 5)} empty="None picked: we compare against the pages that rank" />
        </Row>
      </div>
      <p className="m-0 border-t border-line px-4 py-3 text-[12px] leading-[1.5] text-ink-3">
        Something off? You can change it in Settings once you are in, and the articles after this one follow it.
      </p>
    </section>
  );
}
