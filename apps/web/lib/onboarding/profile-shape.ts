// ---------------------------------------------------------------------------
// The business profile's shape, its empty value and the autocomplete merge
// ---------------------------------------------------------------------------
//
// The half of lib/onboarding/business-profile.ts the browser reads: the
// onboarding wizard starts from EMPTY_PROFILE and the settings autocomplete
// button merges with fillEmptyProfile, and both are client components.
// business-profile.ts reads the site (lib/audit/lenient-fetch.ts, node:http
// and node:https) and calls the model, which Next could only put in a browser
// bundle by shipping polyfills for them, and it did - until 2026-09-25, when a
// guard (lib/__tests__/client-bundle-guard.test.ts) found the chain. No
// imports here, on purpose.

export interface BusinessProfile {
  /** The business's own name for itself, not the domain. */
  name: string;
  /** ISO-ish label, e.g. "English". Free text because the UI shows it. */
  language: string;
  /** Market, e.g. "Global (English)" or "Italy". */
  country: string;
  /** A short positioning paragraph in the site's own terms. */
  description: string;
  /** Who it sells to. Verified as chips in the wizard. */
  audiences: string[];
  /**
   * What people buy from it, in a buyer's words: product types, services,
   * the job it does. The seed list for keyword research is built from these
   * (lib/keyword-research/buyer-seeds.ts). Optional because profiles saved
   * before 2026-09-11 have none.
   */
  offerings?: string[];
  /** Domains, not company names, so they can seed competitive research. */
  competitors: string[];
  /**
   * Rivals read off the results pages for this site's buyer searches and
   * vetted as selling against it (lib/keyword-research/serp-rivals.ts). Found
   * once and kept: the search that finds them starts from model-worded seeds
   * and returned a different valid set on every run, which made each night's
   * keyword pool a different market. Not shown in the wizard.
   */
  searchRivals?: string[];
  buyingJobs?: string[];
  differentiators?: string[];
  exclusions?: string[];
  /**
   * Where an interested buyer goes: a product, pricing, booking or contact
   * page on this site. When the profile was read off the site this is only
   * ever a page the read fetched with a 2xx, or a link on one that answered
   * 2xx; otherwise it is null and `observedChecks.conversionUrl` says why.
   * A person may type one in settings.
   */
  conversionUrl?: string | null;
  /**
   * How each URL the site read proposed was checked, by field. Written by
   * lib/onboarding/observed-facts.ts; the settings screen shows the reason
   * when a field is empty because its proposal failed.
   */
  observedChecks?: Partial<Record<ObservedUrlField, ObservedCheck>>;
  /**
   * When a person last saved this profile: the wizard's finish or the
   * settings form (`saveProfile`, which stamps it server-side). Absent on a
   * profile read off the site and saved by the scheduled repair
   * (lib/keyword-research/business-context.ts) - nobody confirmed that one,
   * and the writer is told so rather than handed model-read offerings as the
   * owner's words.
   */
  confirmedAt?: string | null;
}

/**
 * Profile fields that hold a URL read off the site. Each one is checked
 * before it is stored (lib/onboarding/observed-facts.ts); adding a URL field
 * to the profile means adding it here.
 */
export const OBSERVED_URL_FIELDS = ["conversionUrl"] as const;
export type ObservedUrlField = (typeof OBSERVED_URL_FIELDS)[number];

/** How one observed URL was checked. */
export interface ObservedCheck {
  /** What the model named, before any check; null when it named nothing. */
  proposed: string | null;
  /** True only when the URL was read on the site and answered 2xx. */
  verified: boolean;
  /** Why the field holds what it holds, in words a person can act on. */
  reason: string;
  checkedAt: string;
}

export const EMPTY_PROFILE: BusinessProfile = {
  name: "",
  language: "English",
  country: "Global (English)",
  description: "",
  audiences: [],
  offerings: [],
  competitors: [],
};

/** Which parts of the profile a screen owns, so autocomplete fills only those. */
export type ProfileSection = "business" | "audience";

const SECTION_FIELDS: Record<ProfileSection, (keyof BusinessProfile)[]> = {
  business: ["name", "language", "country", "description"],
  audience: ["offerings", "audiences", "competitors"],
};

/**
 * Merge a proposal into what the person already wrote, filling only what is
 * empty.
 *
 * "Autocomplete with AI" on a settings page is not the wizard: the fields
 * already hold answers someone confirmed, and a button that overwrote them
 * with a fresh guess would be a way to lose work. So a non-empty string stays,
 * a non-empty list stays, and only blanks take the proposal. The wizard's
 * defaults ("English", "Global (English)") count as blank for language and
 * market, since they are what an unfilled profile holds.
 *
 * Returns the merged profile and which fields changed, so the button can say
 * "filled description and 3 audiences" rather than a bare "done".
 */
export function fillEmptyProfile(
  current: BusinessProfile,
  proposed: BusinessProfile,
  section: ProfileSection,
): { profile: BusinessProfile; filled: (keyof BusinessProfile)[] } {
  const next: BusinessProfile = { ...current };
  const filled: (keyof BusinessProfile)[] = [];
  for (const key of SECTION_FIELDS[section]) {
    const have = current[key];
    const want = proposed[key];
    if (Array.isArray(have)) {
      if (have.length === 0 && Array.isArray(want) && want.length > 0) {
        (next[key] as string[]) = want;
        filled.push(key);
      }
      continue;
    }
    const blank =
      typeof have !== "string" ||
      have.trim() === "" ||
      (key === "language" && have === EMPTY_PROFILE.language) ||
      (key === "country" && have === EMPTY_PROFILE.country);
    if (blank && typeof want === "string" && want.trim() !== "") {
      (next[key] as string) = want;
      filled.push(key);
    }
  }
  return { profile: next, filled };
}
