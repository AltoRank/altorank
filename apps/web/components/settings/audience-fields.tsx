"use client";

import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { ChipList, CountedHeading } from "./fields";
import { doubtedAudiences } from "@/lib/onboarding/audience-check";
import { wizardExamples } from "@/lib/onboarding/wizard-rules";

export const MAX_AUDIENCES = 7;
export const MAX_COMPETITORS = 7;
export const MAX_OFFERINGS = 6;

/** Domains, not names: strip a scheme and a path so "https://x.com/pricing" is "x.com". */
export function normaliseCompetitor(c: string): string {
  return c.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
}

/**
 * What people buy, in their words. This is the seed list for keyword research:
 * every research phrase is proposed from these, so a buyer's words here are
 * worth more than any endpoint downstream. The copy says that without the
 * jargon (UX audit 2026-10-12, #12), with examples from the business itself.
 */
export function OfferingList({
  profile,
  patch,
  inputId,
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
  /** For the wizard, which scrolls here when nothing is listed. */
  inputId?: string;
}) {
  const offerings = profile.offerings ?? [];
  const examples = wizardExamples(profile);
  return (
    <>
      <CountedHeading title="What people buy from you" count={offerings.length} max={MAX_OFFERINGS} />
      <ChipList
        items={offerings}
        onChange={(next) => patch({ offerings: next })}
        placeholder={examples.offeringPlaceholder}
        label="Add something people buy from you"
        inputId={inputId}
        max={MAX_OFFERINGS}
      />
      <p className="mt-2 text-[11.5px] text-ink-3">
        Products and services, and the jobs you do. {examples.offeringHelp} We look for what people type into Google about
        these.
      </p>
    </>
  );
}

export function AudienceList({
  profile,
  patch,
  heading = true,
  title = "Target audiences",
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
  /** Off when the list sits under a collapsible section that already names it. */
  heading?: boolean;
  title?: string;
}) {
  const doubted = doubtedAudiences(profile.audiences);
  const quote = (xs: string[]) => xs.map((x) => `“${x}”`).join(", ");
  const examples = wizardExamples(profile);
  return (
    <>
      {heading && <CountedHeading title={title} count={profile.audiences.length} max={MAX_AUDIENCES} />}
      <ChipList
        items={profile.audiences}
        onChange={(audiences) => patch({ audiences })}
        placeholder={examples.audiencePlaceholder}
        label="Add a kind of customer"
        max={MAX_AUDIENCES}
      />
      {/* The one line the first real signup needed: they answered this field
          with the countries they ship to and the things they sell. */}
      <p className="mt-2 text-[11.5px] text-ink-3">{examples.audienceHelp}</p>
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
          We write for the people you name, so say who buys these.
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
