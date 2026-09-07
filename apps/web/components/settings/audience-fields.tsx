"use client";

import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { ChipList, CountedHeading } from "./fields";
import { doubtedAudiences } from "@/lib/onboarding/audience-check";

export const MAX_AUDIENCES = 7;
export const MAX_COMPETITORS = 7;

/** Domains, not names: strip a scheme and a path so "https://x.com/pricing" is "x.com". */
export function normaliseCompetitor(c: string): string {
  return c.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

export function AudienceList({ profile, patch }: { profile: BusinessProfile; patch: (p: Partial<BusinessProfile>) => void }) {
  const doubted = doubtedAudiences(profile.audiences);
  const quote = (xs: string[]) => xs.map((x) => `“${x}”`).join(", ");
  return (
    <>
      <CountedHeading title="Target audiences" count={profile.audiences.length} max={MAX_AUDIENCES} />
      <ChipList
        items={profile.audiences}
        onChange={(audiences) => patch({ audiences })}
        placeholder="e.g. Pop culture fans who wear merch"
        max={MAX_AUDIENCES}
      />
      {/* The one line the first real signup needed: they answered this field
          with the countries they ship to and the things they sell. */}
      <p className="mt-2 text-[11.5px] text-ink-3">
        The people who buy, not where they are or what they buy: a role, a segment, a situation. “Marketing leads at B2B SaaS
        companies”, “Gift buyers looking for themed hoodies”.
      </p>
      {(doubted.places.length > 0 || doubted.products.length > 0) && (
        <p className="mt-1.5 text-[11.5px] text-warn-ink">
          {doubted.places.length > 0 && (
            <>
              {quote(doubted.places)} {doubted.places.length === 1 ? "reads" : "read"} as a market.{" "}
            </>
          )}
          {doubted.products.length > 0 && (
            <>
              {quote(doubted.products)} {doubted.products.length === 1 ? "reads" : "read"} as a product.{" "}
            </>
          )}
          Keywords are chosen for the people you name, so say who buys these.
        </p>
      )}
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
