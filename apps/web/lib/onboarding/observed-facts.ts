// ---------------------------------------------------------------------------
// A URL in the business profile is one the site actually has
// ---------------------------------------------------------------------------
//
// The profile read asked the model for "an observed product, pricing or
// contact URL on this site" and gave it the site's text with every tag
// stripped - so there were no URLs in what it saw, and whatever it returned
// was built from a word. A real signup, 2026-09-22 (Turkish web/mobile
// agency), got `/iletisim` ("contact") stored as observed. It was a 404, and
// the article pointed readers at it.
//
// So an observed URL is now checked before it is stored, and "observed" means
// something checkable: the URL is a page the read fetched with a 2xx, or a
// link found on such a page that answers 2xx when we open it. Anything else is
// stored as null with the reason, never as a guessed path.
//
// The same check runs again when an article is written
// (lib/content/site-facts.ts): a page that answered in onboarding can be gone
// by the tenth draft, and a URL a person typed in settings was never checked.
//
// Server-only: it opens the URL through the SSRF-safe fetcher
// (lib/public-tools/safe-fetch.ts), which needs node:dns. business-profile.ts
// is imported by client components and must not pull that in, which is why
// the checked inference lives here and not there.

import { safeFetch, type SafeFetch } from "@/lib/public-tools/safe-fetch";
import { classifyLinkError, classifyLinkResponse } from "@/lib/seo/link-check";
import { classifyHref, normaliseSiteUrl } from "@/lib/seo/links";
import { CRAWLER_UA } from "@/lib/audit/crawler";
import { e2eStubsEnabled } from "@/lib/e2e/stubs";
import type { ObservedSite } from "./site-text";
import {
  inferBusinessProfileDetailed,
  OBSERVED_URL_FIELDS,
  type BusinessProfile,
  type InferenceResult,
  type ObservedCheck,
} from "./business-profile";

/** What opening one URL on the site established. */
export type SiteUrlCheck =
  /** Answered 2xx. `url` is where it ended, which is what should be linked. */
  | { state: "verified"; url: string; status: number }
  /** Definitively not there: 404/410, gone to the homepage, no such host. */
  | { state: "dead"; url: string; status: number | null; reason: string }
  /** Something stood in the way - a bot wall, a rate limit, a timeout. Unknown. */
  | { state: "unverified"; url: string; status: number | null; reason: string }
  /** Not a URL on this site at all. Never opened. */
  | { state: "rejected"; url: string; reason: string };

export interface CheckOptions {
  fetch?: SafeFetch;
  timeoutMs?: number;
}

const TIMEOUT_MS = 8_000;

/** `https://site/path` for a path, the URL itself for a URL, null for neither. */
export function absoluteOnSite(value: string, domain: string): string | null {
  const origin = `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  try {
    const u = new URL(value.trim(), origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function isRoot(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

/**
 * Open one URL of the site and say what came back.
 *
 * Redirects are followed, by the SSRF-safe fetcher, and judged on where they
 * end: off the site is not this site's page; onto the homepage from anywhere
 * else is how most sites answer for a page they no longer have, so it is
 * dead, not verified. Dead and unverified are told apart with the same rules
 * the citation check uses (lib/seo/link-check.ts), so a 429 from a site that
 * is rate-limiting us never condemns a page that is really there.
 */
export async function checkSiteUrl(url: string, domain: string, opts: CheckOptions = {}): Promise<SiteUrlCheck> {
  if (classifyHref(url, domain) !== "internal" || !/^https?:\/\//i.test(url)) {
    return { state: "rejected", url, reason: `${url} is not on ${domain}` };
  }
  const fetchImpl = opts.fetch ?? safeFetch;
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", userAgent: CRAWLER_UA, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, maxBytes: 64_000 });
  } catch (err) {
    const { verdict, reason } = classifyLinkError(err);
    return verdict === "dead"
      ? { state: "dead", url, status: null, reason }
      : { state: "unverified", url, status: null, reason };
  }
  const { verdict, reason } = classifyLinkResponse(url, { status: res.status, headers: res.headers, body: res.body, method: "GET" });
  if (verdict === "dead") return { state: "dead", url, status: res.status, reason: reason ?? `HTTP ${res.status}` };
  if (verdict === "unverified") return { state: "unverified", url, status: res.status, reason: reason ?? `HTTP ${res.status}` };
  if (res.status >= 300) {
    // A redirect the fetcher was not allowed to follow further.
    return { state: "unverified", url, status: res.status, reason: `HTTP ${res.status}, redirects on further than we follow` };
  }
  if (classifyHref(res.url, domain) !== "internal") {
    return { state: "rejected", url, reason: `${url} redirects off the site, to ${new URL(res.url).hostname}` };
  }
  if (res.redirects.length && isRoot(res.url) && !isRoot(url)) {
    return { state: "dead", url, status: res.status, reason: "redirects to the homepage, which is how a site answers for a page it does not have" };
  }
  return { state: "verified", url: res.url, status: res.status };
}

/** Why a check left the field empty, in words for the settings screen. */
function refusal(check: SiteUrlCheck, proposed: string): string {
  switch (check.state) {
    case "dead":
      return `${proposed} was proposed, but it ${
        check.reason.startsWith("HTTP")
          ? `answered ${check.reason}`
          : check.reason.startsWith("redirects")
            ? check.reason
            : `could not be reached (${check.reason})`
      }. Not stored.`;
    case "unverified":
      return `${proposed} was proposed, but the site did not let us check it (${check.reason}). Not stored until it can be.`;
    case "rejected":
      return `${proposed} was proposed, but ${check.reason}. Not stored.`;
    default:
      return "";
  }
}

/**
 * One observed URL, checked: the URL to store (null when it may not be) and
 * the record of why.
 *
 * Exported for tests. `observed` is what the read can vouch for; a URL that
 * is neither one of its pages nor a link on one was invented, whatever it
 * looks like, and is refused without being opened.
 */
export async function verifyObservedUrl(
  proposed: string | null,
  domain: string,
  observed: ObservedSite | undefined,
  opts: CheckOptions & { now?: Date } = {},
): Promise<{ url: string | null; check: ObservedCheck }> {
  const checkedAt = (opts.now ?? new Date()).toISOString();
  const record = (url: string | null, verified: boolean, reason: string) => ({
    url,
    check: { proposed, verified, reason, checkedAt },
  });

  if (!proposed) {
    return record(null, false, "No product, pricing, booking or contact page was among the links read on the site.");
  }
  const url = absoluteOnSite(proposed, domain);
  if (!url || classifyHref(url, domain) !== "internal") {
    return record(null, false, `${proposed} was proposed, but it is not a page on ${domain}. Not stored.`);
  }

  const key = normaliseSiteUrl(url, domain);
  const readPage = (observed?.pages ?? []).find((p) => normaliseSiteUrl(p, domain) === key);
  if (readPage) {
    // Fetched with a 2xx by the read itself: that is the check.
    return record(readPage, true, `Read on the site when the profile was proposed, and it answered.`);
  }
  const linked = (observed?.links ?? []).some((l) => normaliseSiteUrl(l.url, domain) === key);
  if (!linked) {
    return record(null, false, `${proposed} was proposed, but it is not a page we read or a link on one, so it was a guess. Not stored.`);
  }

  const check = await checkSiteUrl(url, domain, opts);
  if (check.state === "verified") {
    return record(check.url, true, `Linked from a page on the site, and it answered HTTP ${check.status}.`);
  }
  return record(null, false, refusal(check, proposed));
}

/**
 * Check every observed URL in a proposed profile. The rest of the profile is
 * returned as it was.
 */
export async function verifyObservedFacts(
  profile: BusinessProfile,
  domain: string,
  observed: ObservedSite | undefined,
  opts: CheckOptions & { now?: Date } = {},
): Promise<BusinessProfile> {
  const next: BusinessProfile = { ...profile, observedChecks: { ...(profile.observedChecks ?? {}) } };
  for (const field of OBSERVED_URL_FIELDS) {
    const proposed = typeof profile[field] === "string" && profile[field]!.trim() ? profile[field]!.trim() : null;
    const { url, check } = await verifyObservedUrl(proposed, domain, observed, opts);
    next[field] = url;
    next.observedChecks![field] = check;
  }
  return next;
}

/**
 * Read the site and propose a profile whose observed URLs are checked. The
 * one entry point for a profile read off a site: the wizard's proposal and
 * the scheduled path's repair (lib/keyword-research/business-context.ts) both
 * call this, so neither can store a URL the site does not have.
 */
export async function inferVerifiedBusinessProfile(domain: string, opts: CheckOptions = {}): Promise<InferenceResult> {
  const result = await inferBusinessProfileDetailed(domain);
  if (!result.profile) return result;
  // E2E_STUBS: the fixture profile names no URL and the fixture domains do
  // not resolve; nothing here may touch the network under test.
  if (e2eStubsEnabled()) return result;
  return { ...result, profile: await verifyObservedFacts(result.profile, domain, result.observed, opts) };
}
