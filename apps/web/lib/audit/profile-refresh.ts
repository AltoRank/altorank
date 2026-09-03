// ---------------------------------------------------------------------------
// Keeping a site's topical profile in step with the site
// ---------------------------------------------------------------------------
//
// `cron/analyze` selects `first_analysed_at IS NULL`. It is first-look analysis
// for domains nobody has looked at yet, and its own header says re-running is a
// manual action. Nothing else ever rebuilt a profile, so the vocabulary a site
// was given on the day it was added was the vocabulary it kept - while its
// copy, its positioning and its product moved on without it.
//
// That is not a cosmetic drift. The profile is what `scoreRelevance` judges
// every keyword against, so a stale one quietly mis-ranks the whole unattended
// queue, and a scoring fix cannot reach an existing site at all. PR #33 changed
// how profiles are built and was inert in production until each site was
// re-crawled by hand.
//
// Deliberately not `analyseDomain`. That runs readiness, PageSpeed, platform
// detection, keyword discovery, ranked keywords, backlinks and authority, and
// spends DataForSEO credits on every one. A profile needs the crawl and nothing
// else, so a refresh is free apart from the fetches and can run often.

import type { SupabaseClient } from "@supabase/supabase-js";
import { crawlSite } from "./crawler";
import { buildTopicalProfile, profileIsUsable } from "@/lib/seo/topical-profile";

/**
 * How old a profile may get before it is rebuilt.
 *
 * A month, because positioning changes on the scale of a redesign or a launch,
 * not a blog post, and every refresh is a crawl somebody's server has to serve.
 * With refreshes ordered oldest-first and bounded per run, this also spreads
 * the work out instead of re-crawling every site the same night.
 */
export const PROFILE_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

/** A row from the staleness query: enough to decide, not the whole profile. */
export interface ProfileCandidate {
  id: string;
  domain: string | null;
  /** `topical_profile->>builtAt`, null when there is no profile yet. */
  built: string | null;
}

/**
 * Whether a profile is old enough to rebuild.
 *
 * No `builtAt` counts as stale. That is either a workspace analysed before the
 * field existed or one whose analysis failed partway, and both want a profile
 * more than a fresh one does. An unparseable value is treated the same way,
 * because the alternative is a row that can never be selected and so never
 * refreshed - a permanent gap nothing would report.
 */
export function isProfileStale(
  built: string | null | undefined,
  now: Date = new Date(),
  maxAgeDays: number = PROFILE_MAX_AGE_DAYS,
): boolean {
  if (!built) return true;
  const t = Date.parse(built);
  if (Number.isNaN(t)) return true;
  // A profile dated in the future is not stale; clock skew should not cause a
  // re-crawl every run.
  return now.getTime() - t > maxAgeDays * DAY_MS;
}

/**
 * Which candidates to refresh, given the slots available.
 *
 * The caller passes rows already ordered oldest-first, so this stops at the
 * first fresh one rather than scanning: staleness is monotonic in that order.
 */
export function selectStale(
  candidates: readonly ProfileCandidate[],
  slots: number,
  now: Date = new Date(),
  maxAgeDays: number = PROFILE_MAX_AGE_DAYS,
): ProfileCandidate[] {
  if (slots <= 0) return [];
  const out: ProfileCandidate[] = [];
  for (const c of candidates) {
    if (out.length >= slots) break;
    if (!c.domain) continue;
    if (!isProfileStale(c.built, now, maxAgeDays)) break;
    out.push(c);
  }
  return out;
}

export interface RefreshOutcome {
  workspaceId: string;
  domain: string;
  status: "refreshed" | "skipped" | "error";
  detail: string;
}

/**
 * Re-crawl one site and replace its topical profile.
 *
 * Refuses to write a profile it would not trust. An empty or near-empty profile
 * is not a neutral update: `scoreRelevance` returns 1 for everything when there
 * is no vocabulary to judge against, so a failed crawl would not degrade the
 * relevance filter, it would silently switch it off - and the site would keep
 * that state until the next refresh a month later. Keeping yesterday's
 * vocabulary is strictly better than keeping none.
 */
export async function refreshTopicalProfile(
  supabase: SupabaseClient,
  workspaceId: string,
  domain: string,
  now: string = new Date().toISOString(),
): Promise<RefreshOutcome> {
  const base = { workspaceId, domain };
  let pages;
  try {
    pages = await crawlSite(`https://${domain}`, 40, 3, 300);
  } catch (err) {
    return { ...base, status: "error", detail: err instanceof Error ? err.message : "crawl failed" };
  }

  if (!pages.length) {
    return { ...base, status: "skipped", detail: "crawl returned no pages; kept the existing profile" };
  }

  const profile = buildTopicalProfile(domain, pages, now);
  if (!profileIsUsable(profile, domain)) {
    return {
      ...base,
      status: "skipped",
      detail: `crawled ${pages.length} pages but the profile has too few terms to judge relevance; kept the existing one`,
    };
  }

  const { error } = await supabase
    .from("workspaces")
    .update({ topical_profile: profile })
    .eq("id", workspaceId);
  if (error) return { ...base, status: "error", detail: error.message };

  return {
    ...base,
    status: "refreshed",
    detail: `${pages.length} pages, ${Object.keys(profile.terms).length} terms`,
  };
}
