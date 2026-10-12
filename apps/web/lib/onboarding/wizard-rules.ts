// ---------------------------------------------------------------------------
// The wizard's decisions, as functions
// ---------------------------------------------------------------------------
//
// What the "Check what we found" screen decides - which rival is pre-ticked,
// what may stop the main button, what each collapsed line says, which
// examples it shows - lifted out of wizard.tsx so each is asserted in a test
// rather than read off a screenshot (this repo renders components to markup
// only; there is no DOM in the unit tier). Client-safe: type imports only.

import type { BusinessProfile } from "./profile-shape";
import type { CompetitorSuggestion } from "./competitor-suggestions";
import type { SiteDetails } from "./output-settings";

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const hostOf = (s: string) => s.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();

/**
 * One entry typed into the competitor box: a website (looked up and read by
 * research) or a name (kept as written, never looked up as a host). Null for
 * an empty box.
 */
export function competitorEntry(raw: string): { kind: "domain"; text: string } | { kind: "name"; text: string } | null {
  const text = raw.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!text) return null;
  const host = hostOf(text);
  return DOMAIN_SHAPE.test(host) ? { kind: "domain", text: host } : { kind: "name", text };
}

/**
 * The rival ticked for the owner when they have none: the first suggestion
 * that is not bigger than the site (a rival your size is the comparison that
 * can be won), else the first. Null when they already have one, or there is
 * nothing to suggest - which is fine: competitors are optional.
 */
export function preTickRival(chosen: readonly string[], suggestions: readonly CompetitorSuggestion[]): CompetitorSuggestion | null {
  if (chosen.length > 0) return null;
  const open = suggestions.filter((s) => !chosen.includes(s.domain));
  return open.find((s) => s.size !== "bigger") ?? open[0] ?? null;
}

/**
 * Text left in the competitor box when the main button is pressed, kept
 * rather than dropped: a website joins the websites, anything else the names.
 * No lookup - the click does not wait on a search.
 */
export function withPendingCompetitor(profile: BusinessProfile, draft: string): BusinessProfile {
  const entry = competitorEntry(draft);
  if (!entry) return profile;
  if (entry.kind === "domain") {
    return profile.competitors.includes(entry.text) ? profile : { ...profile, competitors: [...profile.competitors, entry.text] };
  }
  const names = profile.competitorNames ?? [];
  return names.some((n) => n.toLowerCase() === entry.text.toLowerCase()) ? profile : { ...profile, competitorNames: [...names, entry.text] };
}

/** What may stop the main button, and the field it sends the person to. */
export type FinishBlocker = { field: "offerings"; message: string };

/**
 * The one thing the run cannot start without: something the business sells,
 * or a description of it. With neither, the buyer seeds have nothing to start
 * from (lib/keyword-research/buyer-seeds.ts) and the run ends on "nothing
 * planned" after a minute and a half of waiting. Competitors are not on this
 * list: discovery plans without them.
 */
export function finishBlocker(profile: BusinessProfile): FinishBlocker | null {
  const sells = (profile.offerings ?? []).some((o) => o.trim());
  const described = profile.description.trim().length > 0;
  if (sells || described) return null;
  return { field: "offerings", message: "Add one thing people buy from you, so we know what to write about." };
}

/** The business section's collapsed line: the description, with the name only when the description does not start with it. */
export function businessLine(profile: Pick<BusinessProfile, "name" | "description">): string {
  const name = profile.name.trim();
  const first = firstSentence(profile.description);
  if (name && first.toLowerCase().startsWith(name.toLowerCase())) return first;
  return [name, first].filter(Boolean).join(" · ");
}

/** "Italian · Italy": always on screen, because these two decide the market every search is read in. */
export function localeLine(profile: Pick<BusinessProfile, "language" | "country">): string {
  return [profile.language.trim() || "English", profile.country.trim() || "Global (English)"].join(" · ");
}

/** The first sentence of a description, for a collapsed line. */
export function firstSentence(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).slice(0, 140);
}

export type SiteBadge = "found" | "looking" | "optional";

/**
 * "Where your content lives": what its collapsed line says. Optional, so a
 * site with no blog is said plainly and calmly - most small businesses have
 * none - never as a warning.
 */
export function siteSummary(site: SiteDetails, looking: boolean, domain: string): { line: string; badge: SiteBadge } {
  if (looking) return { line: `Looking for a blog on ${domain}…`, badge: "looking" };
  const parts = [
    site.blogRootUrl ? "Found your blog" : null,
    site.sitemapUrl ? (site.blogRootUrl ? "your sitemap" : "Found your sitemap") : null,
    site.exampleArticleUrls.length ? `${site.exampleArticleUrls.length} example ${site.exampleArticleUrls.length === 1 ? "post" : "posts"}` : null,
  ].filter(Boolean);
  if (parts.length) return { line: parts.join(", "), badge: "found" };
  return { line: "No blog yet, and that is fine. You choose where articles go when you publish.", badge: "optional" };
}

/**
 * Examples in the owner's own terms. A clinic was shown "order picking
 * software" and "Marketing leads at B2B SaaS companies" (UX audit #12); the
 * examples now come from what the read found the business sells, and plain
 * small-business ones when it found nothing.
 */
export function wizardExamples(profile: Pick<BusinessProfile, "offerings">): {
  offeringPlaceholder: string;
  offeringHelp: string;
  audiencePlaceholder: string;
  audienceHelp: string;
} {
  const offering = (profile.offerings ?? []).map((o) => o.trim()).find((o) => o.length > 0 && o.length <= 60) ?? null;
  return {
    offeringPlaceholder: offering ? "Add another thing you sell" : "e.g. sports massage, wedding cakes, boiler repair",
    offeringHelp: offering
      ? `Write each one the way a customer would search for it: “${offering}” works better than a slogan.`
      : "Write each one the way a customer would search for it: “back pain treatment” works better than a slogan.",
    audiencePlaceholder: offering ? `e.g. people looking for ${offering}` : "e.g. new parents, local runners, small restaurant owners",
    audienceHelp:
      "Who buys from you, not where they are or what they buy: a kind of person, or the situation they are in. “Office workers with back pain”, “couples planning a wedding”.",
  };
}
