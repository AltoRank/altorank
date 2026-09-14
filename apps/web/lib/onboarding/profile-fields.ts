import type { BusinessFocus } from "./profile-focus";
export interface BusinessProfile extends BusinessFocus {
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
  buyingJobs?: string[];
  differentiators?: string[];
  exclusions?: string[];
  conversionUrl?: string;
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
        (next as unknown as Record<string, unknown>)[key] = want;
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
