import { parseCapabilities } from "./profile-focus";
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

import { askStructured, type SpendSink } from "@/lib/keyword-research/buyer-model";
import { readSiteText, type SiteTextSource, MIN_CHARS } from "./site-text";
import { e2eStubsEnabled, stubInferProfile } from "@/lib/e2e/stubs";

import type { BusinessProfile } from "./profile-fields";
export { EMPTY_PROFILE, fillEmptyProfile, type BusinessProfile, type ProfileSection } from "./profile-fields";

/** Enough of the site to characterise it; more than this is wasted tokens. */
// 8k chars is plenty to describe a business and keeps the proposal under ~15 s.
const MAX_CHARS = 8_000;

const PROMPT = [
  "You are reading a company's website to fill in their profile for an SEO tool.",
  "Return ONLY a JSON object, no prose, no code fence, with exactly these keys:",
  '{"name","language","country","description","audiences","offerings","competitors","buyingJobs","differentiators","exclusions","conversionUrl","primaryBuyer","priorityOffering","capabilities"}',
  "",
  "- name: what the business calls itself.",
  "- language: the language the site is written in, in English (e.g. \"English\", \"Italian\").",
  '- country: the market it sells to. Use "Global (English)" when it is not country-specific.',
  "- description: 2-4 sentences of positioning, in plain prose, using the site's own claims.",
  "  Do not invent features, pricing, or customers that the text does not support.",
  "- audiences: up to 6 evidenced buyer segments, each a short noun phrase.",
  "  Specific beats broad: \"E-commerce teams on Shopify\" not \"businesses\".",
  "- offerings: up to 6 things people buy from it, each 2-4 words in the words a buyer would search,",
  "  not the site's slogans: \"order picking software\" not \"fulfilment reimagined\". Products, services, the job it does.",
  "- primaryBuyer: suggest ONE evidenced audience to focus on first; priorityOffering: ONE offering for that buyer. Use empty strings when unknown.",
  '- capabilities: up to 8 objects {claim,sourceUrl,quote}. Each is a specific product capability with a short exact supporting quote and observed SOURCE URL. Omit capabilities with no evidence; never infer compliance, integrations or roles.',
  "- buyingJobs: up to 4 concrete tasks buyers need help completing, supported by the text.",
  "- differentiators: up to 4 supported reasons to choose this business. Do not invent superiority.",
  "- exclusions: audiences or needs explicitly not served; [] when unknown.",
  "- conversionUrl: an observed product, pricing or contact URL on this site; empty when unknown.",
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
export async function inferBusinessProfileDetailed(domain: string, spend?: SpendSink): Promise<InferenceResult> {
  // E2E_STUBS: a fixture instead of a site read and a model call (lib/e2e/stubs.ts).
  if (e2eStubsEnabled()) return stubInferProfile(domain);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { profile: null, reason: "no_model", source: "none" };

  const read = await readSiteText(domain, MAX_CHARS);
  if (read.source === "none" || read.text.length < Math.min(MIN_CHARS, 250)) {
    return { profile: null, reason: "unreadable", source: read.source };
  }

  try {
    const raw = await askStructured("onboarding/business-profile", `${PROMPT}\n\nSITE: ${domain}\n\n${read.text}`, { maxTokens: 2200, spend });
    const profile = parseProfile(raw ?? "", domain, read.text);
    return profile ? { profile, reason: "ok", source: read.source } : { profile: null, reason: "model_failed", source: read.source };
  } catch {
    return { profile: null, reason: "model_failed", source: read.source };
  }
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
export function parseProfile(raw: string, domain: string, sourceText = ""): BusinessProfile | null {
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
    conversionUrl: typeof parsed.conversionUrl === "string" ? parsed.conversionUrl : "",
    primaryBuyer: typeof parsed.primaryBuyer === "string" ? parsed.primaryBuyer.slice(0, 200) : "",
    priorityOffering: typeof parsed.priorityOffering === "string" ? parsed.priorityOffering.slice(0, 200) : "",
    capabilities: parseCapabilities(parsed.capabilities, domain, sourceText),
    // A model asked for competitors will happily return the site itself, which
    // then seeds research against its own domain.
    competitors: strings(parsed.competitors)
      .map((c) => c.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase())
      .filter((c) => c !== host)
      .slice(0, 6),
  };
}
