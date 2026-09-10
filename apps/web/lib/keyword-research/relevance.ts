// ---------------------------------------------------------------------------
// What a researched keyword is judged against, and making sure there is one
// ---------------------------------------------------------------------------
//
// The first look (lib/audit/domain-analysis.ts) never stores a keyword the
// site's own vocabulary rejects. The research drawer did: Generate, the
// playbooks, Find and Import went from the provider to the table through a
// funnel that knew volume, difficulty and duplicates and nothing about the
// site. Measured on a real signup, 2026-09-09: its crawl had failed, so the
// workspace had no topical profile; eleven minutes before that profile was
// built by the nightly refresh, the person ran research and was handed
// "shipping" (KD 91), "estimate shipping cost usps", "ups shipping calculator"
// and a competitor's name misspelt - and wrote an article on one of them.
// `scoreRelevance` had answered 1 for every term, because there was nothing
// to judge against, and nothing asked why.
//
// Two changes. The judge is built here, once per run, and it *gets* a
// vocabulary when the workspace has none: a crawl is free (no provider call),
// takes seconds, and is the same `refreshTopicalProfile` the nightly pass
// runs. Only when the site still cannot be read does it fall back to the
// business profile alone, and it says so. And the judgement rides on each
// candidate, so the table can show it and the funnel can count it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { refreshTopicalProfile } from "@/lib/audit/profile-refresh";
import { profileIsUsable, scoreRelevance, subjectVocabulary, type TopicalProfile } from "@/lib/seo/topical-profile";
import type { RelevanceBasis, ResearchCandidate } from "./types";

export interface RelevanceJudge {
  basis: RelevanceBasis;
  /** One line for the run's trace: what the terms were judged against. */
  note: string;
  judge: (term: string) => NonNullable<ResearchCandidate["relevance"]>;
}

/**
 * Build the judge for one workspace, crawling first if it has no vocabulary.
 *
 * `topical` is what the caller already read off the workspace row; `null`
 * when the column is empty. The refresh is attempted once and its outcome is
 * trusted: a site that cannot be crawled now is judged on the business
 * profile, not retried inside a request a person is waiting on.
 */
export async function relevanceJudge(
  supabase: SupabaseClient,
  ws: { id: string; domain: string; profile: BusinessProfile; topical: TopicalProfile | null },
): Promise<RelevanceJudge> {
  let topical = ws.topical;
  let refreshed: string | null = null;
  if (!profileIsUsable(topical, ws.domain) && ws.domain) {
    const out = await refreshTopicalProfile(supabase, ws.id, ws.domain);
    if (out.status === "refreshed") {
      const { data } = await supabase.from("workspaces").select("topical_profile").eq("id", ws.id).maybeSingle();
      topical = (data?.topical_profile as TopicalProfile | null) ?? null;
      refreshed = "read the site first";
    } else {
      refreshed = `could not read the site (${out.detail})`;
    }
  }
  return judgeFrom(ws.profile, topical, ws.domain, refreshed);
}

/** The pure part, so the choice of basis is testable without a database. */
export function judgeFrom(
  business: BusinessProfile | null,
  topical: TopicalProfile | null,
  domain: string,
  refreshed: string | null = null,
): RelevanceJudge {
  const usable = profileIsUsable(topical, domain);
  const subject = subjectVocabulary(business, usable ? topical : null);
  const basis: RelevanceBasis = usable ? "site" : subject.size ? "business" : "none";
  const prefix = refreshed ? `${refreshed[0].toUpperCase()}${refreshed.slice(1)}; ` : "";
  const note =
    basis === "site"
      ? `${prefix}judged every candidate against the site's own pages`
      : basis === "business"
        ? `${prefix}the site has no readable vocabulary yet, so candidates were judged against the business profile only`
        : `${prefix}nothing to judge relevance against yet: no readable site and an empty business profile`;
  return {
    basis,
    note,
    judge: (term) => {
      const r = scoreRelevance(term, usable ? topical : null, subject);
      return { score: r.score, basis, reason: r.reason };
    },
  };
}

/** Attach a judgement to every candidate. Pure; drops nothing. */
export function judgeCandidates(candidates: ResearchCandidate[], judge: RelevanceJudge): ResearchCandidate[] {
  return candidates.map((c) => ({ ...c, relevance: judge.judge(c.term) }));
}
