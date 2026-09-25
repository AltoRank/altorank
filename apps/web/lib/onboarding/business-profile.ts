// ---------------------------------------------------------------------------
// What this business is, read off its own website
// ---------------------------------------------------------------------------
//
// Onboarding used to open on empty fields: a domain box, then a wait, then a
// dashboard. Everything the product needed to know about the business it was
// writing for had to be typed by someone who had just arrived.
//
// This reads the site instead and proposes the answers. The person verifies and
// corrects rather than authors, which is a much smaller ask at the moment they
// are least invested. Nothing here is trusted blindly - every field lands in a
// form they can edit before it is saved.
//
// One model call, structured output, on the cheap tier. It runs before keyword
// research so the audiences it finds can steer what we look for.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "@/lib/ai/models";
import { readSiteText, type ObservedSite, type SiteTextSource, MIN_CHARS } from "./site-text";
import { e2eStubsEnabled, stubInferProfile } from "@/lib/e2e/stubs";

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

/** Enough of the site to characterise it; more than this is wasted tokens. */
// 8k chars is plenty to describe a business and keeps the proposal under ~15 s.
const MAX_CHARS = 8_000;

const PROMPT = [
  "You are reading a company's website to fill in their profile for an SEO tool.",
  "Return ONLY a JSON object, no prose, no code fence, with exactly these keys:",
  '{"name","language","country","description","audiences","offerings","competitors","buyingJobs","differentiators","exclusions","conversionUrl"}',
  "",
  "- name: what the business calls itself.",
  "- language: the language the site is written in, in English (e.g. \"English\", \"Italian\").",
  '- country: the market it sells to. Use "Global (English)" when it is not country-specific.',
  "- description: 2-4 sentences of positioning, in plain prose, using the site's own claims.",
  "  Do not invent features, pricing, or customers that the text does not support.",
  "- audiences: 3-6 specific buyer segments, each a short noun phrase.",
  "  Specific beats broad: \"E-commerce teams on Shopify\" not \"businesses\".",
  "- offerings: 3-6 things people buy from it, each 2-4 words in the words a buyer would search,",
  "  not the site's slogans: \"order picking software\" not \"fulfilment reimagined\". Products, services, the job it does.",
  "- buyingJobs: up to 4 concrete tasks buyers need help completing, supported by the text.",
  "- differentiators: up to 4 supported reasons to choose this business. Do not invent superiority.",
  "- exclusions: audiences or needs explicitly not served; [] when unknown.",
  "- conversionUrl: the product, pricing, booking or contact page an interested buyer should go to. Copy it",
  "  exactly from LINKS ON THE PAGES READ below. Never write a URL that is not in that list, never build one",
  "  from a word (\"/contact\"); return \"\" when no link in the list is such a page.",
  "- competitors: up to 3 direct competitors serving the same buyer and buying job. Verify from evidence in the text; return [] when unknown.",
  "  Do not substitute famous software tools for a service business, or name this site's own domain.",
  "  Return [] rather than guessing if the category is unclear.",
].join("\n");

export type InferenceReason = "ok" | "no_model" | "unreadable" | "model_failed" | "needs_plan";

export interface InferenceResult {
  profile: BusinessProfile | null;
  /** Why `profile` is null, or "ok". The wizard shows this instead of pretending. */
  reason: InferenceReason;
  /** Which read of the site produced the text the model saw. */
  source: SiteTextSource;
  /**
   * The pages the read fetched with a 2xx and the links on them: the only
   * evidence an observed URL in `profile` may come from. Absent when nothing
   * was fetched (fixtures, no model).
   */
  observed?: ObservedSite;
  /**
   * The exact sentence to show, when the reason alone does not carry it.
   * `needs_plan` is the only producer: the billing gate's refusal names the
   * account's state ("out of free drafts", "paused until 3 October", "the
   * card was declined"), which a static copy map cannot.
   */
  message?: string;
}

/**
 * Read `domain` and propose a profile, saying how it went.
 *
 * `unreadable` is the common failure and it is not ours to hide: a
 * client-rendered homepage, a block page or a site with nothing on it all
 * yield too little text to describe a business from. The wizard tells the
 * person that and asks; the earlier version showed empty fields under the
 * words "we've filled this in".
 */
export async function inferBusinessProfileDetailed(domain: string): Promise<InferenceResult> {
  // E2E_STUBS: a fixture instead of a site read and a model call (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubInferProfile(domain);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { profile: null, reason: "no_model", source: "none" };

  const read = await readSiteText(domain, MAX_CHARS);
  if (read.source === "none" || read.text.length < Math.min(MIN_CHARS, 250)) {
    return { profile: null, reason: "unreadable", source: read.source, observed: read.observed };
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: anthropicModel("structured"),
      max_tokens: 1200,
      messages: [{ role: "user", content: `${PROMPT}\n\nSITE: ${domain}\n\n${read.text}\n\n${linksForPrompt(read.observed)}` }],
    });
    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const profile = parseProfile(raw, domain);
    return profile
      ? { profile, reason: "ok", source: read.source, observed: read.observed }
      : { profile: null, reason: "model_failed", source: read.source, observed: read.observed };
  } catch {
    return { profile: null, reason: "model_failed", source: read.source, observed: read.observed };
  }
}

/**
 * The links the model may pick a conversion page from. Named as the only
 * source, and said to be empty when it is, so an absent list is not read as
 * permission to guess.
 */
export function linksForPrompt(observed: ObservedSite | undefined): string {
  const links = observed?.links ?? [];
  if (!links.length) return "LINKS ON THE PAGES READ: none were found, so conversionUrl must be \"\".";
  return ["LINKS ON THE PAGES READ:", ...links.map((l) => `- ${l.text || "(no text)"}: ${l.url}`)].join("\n");
}

/**
 * Read `domain` and propose a profile.
 *
 * Returns null when there is nothing to read or no API key: the caller shows an
 * empty form rather than a failure. Kept for callers that only need the
 * profile; the wizard uses the detailed form.
 */
export async function inferBusinessProfile(domain: string): Promise<BusinessProfile | null> {
  return (await inferBusinessProfileDetailed(domain)).profile;
}

/**
 * Parse the model's reply, defensively.
 *
 * Exported for tests: the failure this guards against is a model that wraps
 * JSON in a code fence or adds a sentence before it, which turns a working
 * onboarding into a blank one.
 */
export function parseProfile(raw: string, domain: string): BusinessProfile | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

  const host = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();

  return {
    name: typeof parsed.name === "string" ? parsed.name : "",
    language: typeof parsed.language === "string" ? parsed.language : "English",
    country: typeof parsed.country === "string" ? parsed.country : "Global (English)",
    description: typeof parsed.description === "string" ? parsed.description : "",
    audiences: strings(parsed.audiences).slice(0, 6),
    offerings: strings(parsed.offerings).slice(0, 6),
    buyingJobs: strings(parsed.buyingJobs).slice(0, 4),
    differentiators: strings(parsed.differentiators).slice(0, 4),
    exclusions: strings(parsed.exclusions).slice(0, 6),
    // Unchecked here: parsing cannot know whether the site has the page.
    // lib/onboarding/observed-facts.ts checks it before anything stores it.
    conversionUrl: typeof parsed.conversionUrl === "string" && parsed.conversionUrl.trim() ? parsed.conversionUrl.trim() : null,
    // A model asked for competitors will happily return the site itself, which
    // then seeds research against its own domain.
    competitors: strings(parsed.competitors)
      .map((c) => c.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase())
      .filter((c) => c !== host)
      .slice(0, 6),
  };
}

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
