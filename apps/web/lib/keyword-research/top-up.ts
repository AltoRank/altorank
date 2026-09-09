// ---------------------------------------------------------------------------
// Topping up a pool that has run out of keywords worth writing
// ---------------------------------------------------------------------------
//
// Discovery runs once. `analyseDomain` crawls the site, expands a handful of
// seeds and stores about twenty keywords, and `cron/analyze` says so in its own
// header: "Re-running the full analysis is still a manual action."
//
// Twenty keywords is a few weeks of writing. After that the queue answers "no
// keyword qualifies: all are covered, already ranking, or flagged as provider
// noise" and the account quietly stops producing - which is what qasimcode.com
// did on its fifth article, with fifteen keywords still sitting in `new` and
// every one of them out of reach at authority 0. The pool was not empty. The
// WRITABLE pool was, and nothing existed to refill it.
//
// Two sources, cheapest first.
//
// 1. What we already bought. Every generated article stores its research, and
//    that research carries up to thirty related keywords and the People Also
//    Ask questions, with volumes. qasimcode.com had 75 distinct terms sitting
//    in five articles, none of them in its keyword table. Harvesting costs
//    nothing.
//
// 2. What the customer told us. `seeds.ts` builds playbook phrases from the
//    confirmed profile - "<category> for <audience>", "best <category> for
//    <audience>", "how much does <category> cost". Onboarding uses a few slots
//    of this; the rest have never been asked for.
//
// Both are candidate STRINGS. One keyword_overview call prices up to 700 of
// them (about $0.012 for three, so a full top-up is one cheap round trip), and
// that is the only money this spends.
//
// The filter at the door is the point. A top-up that adds more head terms the
// site cannot rank for leaves the writable pool exactly as empty as it found
// it, so a candidate is stored only if it is reachable at this site's measured
// authority and not arguing against what the business sells.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { fetchTermMetrics, type TermMetrics } from "./metrics";
import { MIN_VOLUME } from "./funnel";
import { buildPlaybookSeeds, brandFromDomain, type PlaybookId } from "./seeds";
import { isOutOfReach } from "@/lib/seo/difficulty";
import { commercialFit } from "@/lib/seo/commercial-fit";
import { scoreRelevance, subjectVocabulary, type TopicalProfile } from "@/lib/seo/topical-profile";

/** Never store more than this from one top-up: a queue, not a dump. */
export const TOP_UP_MAX = 40;

/** Terms per top-up worth pricing. One call covers 700; this bounds the write. */
export const TOP_UP_CANDIDATE_CAP = 300;

/**
 * The playbooks a top-up asks for.
 *
 * Deliberately the audience- and category-shaped ones. They are what produced
 * the only keywords qasimcode.com ever got that named its actual customers
 * ("best dental clinic website"), where the site's own headings produced the
 * "web design agency" head terms it cannot rank for.
 */
export const TOP_UP_PLAYBOOKS: readonly PlaybookId[] = [
  "use_case",
  "best_of",
  "pricing",
  "glossary",
  "alternatives",
];

export interface TopUpOutcome {
  /** Distinct candidate strings gathered, before anything was priced. */
  candidates: number;
  /** How many the provider knew. */
  priced: number;
  /** Rows written. */
  inserted: number;
  /** Provenance of what went in, for the run log. */
  bySource: { ideas: number; playbook: number };
  /** Why nothing was added, when nothing was. */
  reason?: string;
}

type ResearchRow = { research: unknown };

/**
 * Related keywords and People Also Ask questions out of stored article
 * research: terms this workspace has already paid a provider for.
 */
export function harvestFromResearch(rows: ResearchRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const research = row.research as
      | { relatedKeywords?: unknown; peopleAlsoAsk?: unknown }
      | null
      | undefined;
    if (!research || typeof research !== "object") continue;

    if (Array.isArray(research.relatedKeywords)) {
      for (const k of research.relatedKeywords) {
        const term = (k as { keyword?: unknown })?.keyword;
        if (typeof term === "string" && term.trim()) out.push(term.trim());
      }
    }
    if (Array.isArray(research.peopleAlsoAsk)) {
      for (const q of research.peopleAlsoAsk) {
        if (typeof q === "string" && q.trim()) out.push(q.trim());
      }
    }
  }
  return out;
}

/** Playbook phrases from the profile the customer confirmed. */
export function playbookCandidates(
  profile: BusinessProfile | null | undefined,
  domain: string,
): string[] {
  if (!profile) return [];
  const ctx = {
    brand: brandFromDomain(domain),
    profile: {
      description: profile.description ?? "",
      audiences: profile.audiences ?? [],
      competitors: profile.competitors ?? [],
    },
  };
  return TOP_UP_PLAYBOOKS.flatMap((id) => buildPlaybookSeeds(id, ctx));
}

/** Lower-cased, de-duplicated, minus everything the workspace already has. */
export function newCandidates(raw: string[], known: Iterable<string>): string[] {
  const seen = new Set([...known].map((t) => t.trim().toLowerCase()));
  const out: string[] = [];
  for (const term of raw) {
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term.trim());
  }
  return out;
}

/**
 * Fill the cap most-on-topic first.
 *
 * Relevance ranks here, it does not reject. Sorting by volume alone decided
 * the cap by the wrong criterion: harvesting qasimcode.com's articles turned
 * up "whitepages removal" and a run of business-directory terms - the residue
 * of one off-target article - sitting above its clinic and booking terms on
 * raw volume alone. A hard relevance cut is the wrong answer too, because some
 * of the best finds are deliberately off-vocabulary: "squarespace pricing" and
 * "calendly alternatives" name products this site does not sell, to people who
 * are deciding whether to buy one instead of hiring anybody. So the noise
 * falls below the cap rather than being judged, and `recommendKeywords` scores
 * whatever got in.
 */
export function rankForStorage(
  metrics: TermMetrics[],
  relevanceOf: (term: string) => number,
  limit: number,
): TermMetrics[] {
  return metrics
    .map((m) => ({ m, relevance: relevanceOf(m.term) }))
    .sort((a, b) => b.relevance - a.relevance || (b.m.volume ?? 0) - (a.m.volume ?? 0))
    .slice(0, limit)
    .map((x) => x.m);
}

export interface KeepOptions {
  authority: number | null;
  subject: Set<string> | null;
  description: string | null;
}

/**
 * Is this priced candidate worth a row?
 *
 * Unknown volume is not zero (rule 5), but it is also not a reason to write:
 * a term nobody can size cannot be ranked against the others, and the pool has
 * no shortage of candidates. Unknown difficulty IS kept - `isOutOfReach`
 * declines to judge it, and `recommendKeywords` will weigh it later.
 */
export function worthStoring(m: TermMetrics, opts: KeepOptions): boolean {
  if (m.volume === null || m.volume < MIN_VOLUME) return false;
  if (isOutOfReach(m.difficulty, opts.authority)) return false;
  const fit = commercialFit(m.term, opts.subject, opts.description);
  return fit.fit !== "absence";
}

/**
 * Refill a workspace's writable pool.
 *
 * Returns what it did rather than throwing: the caller is a cron running over
 * every workspace, and one site whose provider call failed must not stop the
 * rest.
 */
export async function topUpKeywords(
  supabase: SupabaseClient,
  workspaceId: string,
  options: { locale?: string; locationCode?: number; limit?: number } = {},
): Promise<TopUpOutcome> {
  const empty: TopUpOutcome = { candidates: 0, priced: 0, inserted: 0, bySource: { ideas: 0, playbook: 0 } };

  const { data: ws } = await supabase
    .from("workspaces")
    .select("domain, dr, business_profile, topical_profile")
    .eq("id", workspaceId)
    .single();
  if (!ws) return { ...empty, reason: "workspace not found" };

  const { data: existing } = await supabase
    .from("keywords")
    .select("term")
    .eq("workspace_id", workspaceId);
  const known = (existing ?? []).map((k) => String(k.term ?? ""));

  const { data: articles } = await supabase
    .from("articles")
    .select("research")
    .eq("workspace_id", workspaceId)
    .not("research", "is", null);

  const harvested = harvestFromResearch((articles ?? []) as ResearchRow[]);
  const playbook = playbookCandidates(
    (ws.business_profile as BusinessProfile | null) ?? null,
    String(ws.domain ?? ""),
  );
  // Which list a term came from, for provenance. Harvest wins a tie: it is the
  // one we have already paid for.
  const origin = new Map<string, "ideas" | "playbook">();
  for (const t of playbook) origin.set(t.trim().toLowerCase(), "playbook");
  for (const t of harvested) origin.set(t.trim().toLowerCase(), "ideas");

  const candidates = newCandidates([...harvested, ...playbook], known).slice(0, TOP_UP_CANDIDATE_CAP);
  if (candidates.length === 0) {
    return { ...empty, reason: "nothing new to price: no stored research and no profile playbooks" };
  }

  let metrics: Map<string, TermMetrics>;
  try {
    metrics = await fetchTermMetrics(candidates, {
      languageCode: options.locale ?? "en",
      locationCode: options.locationCode,
    });
  } catch (err) {
    return {
      ...empty,
      candidates: candidates.length,
      reason: `could not price candidates: ${err instanceof Error ? err.message : "provider call failed"}`,
    };
  }

  const business = (ws.business_profile as BusinessProfile | null) ?? null;
  const subject = subjectVocabulary(business, (ws.topical_profile as TopicalProfile | null) ?? null);
  const description = business?.description ?? null;
  const authority = typeof ws.dr === "number" ? ws.dr : null;

  const topical = (ws.topical_profile as TopicalProfile | null) ?? null;
  const keep = rankForStorage(
    [...metrics.values()].filter((m) => worthStoring(m, { authority, subject, description })),
    (term) => scoreRelevance(term, topical, subject).score,
    options.limit ?? TOP_UP_MAX,
  );

  if (keep.length === 0) {
    return {
      ...empty,
      candidates: candidates.length,
      priced: metrics.size,
      reason: "none of the candidates were both reachable at this site's authority and on-message",
    };
  }

  const rows = keep.map((m) => {
    const source = origin.get(m.term.toLowerCase()) ?? "ideas";
    return {
      workspace_id: workspaceId,
      term: m.term,
      volume: m.volume,
      difficulty: m.difficulty,
      cpc: m.cpc,
      intent: m.intent,
      status: "new",
      source: "ideas",
      source_type: source,
      source_ref: source === "ideas" ? "article research" : "profile playbook",
    };
  });

  const { error } = await supabase.from("keywords").insert(rows);
  if (error) {
    return {
      ...empty,
      candidates: candidates.length,
      priced: metrics.size,
      reason: `could not store keywords: ${error.message}`,
    };
  }

  return {
    candidates: candidates.length,
    priced: metrics.size,
    inserted: rows.length,
    bySource: {
      ideas: rows.filter((r) => r.source_type === "ideas").length,
      playbook: rows.filter((r) => r.source_type === "playbook").length,
    },
  };
}
