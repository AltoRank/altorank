"use client";

import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { ChipList, CountedHeading } from "./fields";

export const MAX_AUDIENCES = 7;
export const MAX_COMPETITORS = 7;

/** Domains, not names: strip a scheme and a path so "https://x.com/pricing" is "x.com". */
export function normaliseCompetitor(c: string): string {
  return c.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

export function AudienceList({ profile, patch }: { profile: BusinessProfile; patch: (p: Partial<BusinessProfile>) => void }) {
  return (
    <>
      <CountedHeading title="Target audiences" count={profile.audiences.length} max={MAX_AUDIENCES} />
      <ChipList
        items={profile.audiences}
        onChange={(audiences) => patch({ audiences })}
        placeholder="e.g. Content managers at B2B SaaS companies"
        max={MAX_AUDIENCES}
      />
    </>
  );
}

export function CompetitorList({ profile, patch }: { profile: BusinessProfile; patch: (p: Partial<BusinessProfile>) => void }) {
  return (
    <>
      <CountedHeading title="Competitors" count={profile.competitors.length} max={MAX_COMPETITORS} />
      <ChipList
        items={profile.competitors}
        onChange={(competitors) => patch({ competitors: competitors.map(normaliseCompetitor) })}
        placeholder="e.g. competitor.com"
        max={MAX_COMPETITORS}
      />
      <p className="mt-2 text-[11.5px] text-ink-3">Domains, not names. Bigger competitors give more keyword ideas.</p>
    </>
  );
}
