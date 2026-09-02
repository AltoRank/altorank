// ---------------------------------------------------------------------------
// The free growth plan: what a site should publish next, from its domain alone
// ---------------------------------------------------------------------------
//
// This is the hook on the homepage. A visitor types a domain and, in the time
// it takes to read the headline, gets three things back about *their* site:
//
//   1. Closest wins: terms they already rank for on page two, with the page
//      that earns them. One revision from page one, and checkable in a SERP.
//   2. Gaps: terms their organic competitors rank for and they do not.
//   3. Readiness: whether an AI assistant can read the site at all, with the
//      fixes generated rather than described.
//
// Every line refers to a URL or a term the visitor can verify. Nothing here
// forecasts traffic, because nothing here has measured any, and the site's
// hard rule against unmeasured numbers applies to a prospect's site exactly as
// much as to ours.
//
// Pure functions first, orchestration last, so the shaping is unit-testable
// without a network and the route is a thin wrapper.

import {
  fetchRankedKeywords,
  strikingDistance,
  type RankedKeyword,
} from "@/lib/seo/ranked-keywords";
import { fetchOrganicCompetitors, type OrganicCompetitor } from "@/lib/seo/competitors";
import { buildReadinessReport, type ReadinessArtifact } from "@/lib/audit/readiness-report";
import { analyseDomain } from "@/lib/audit/domain-analysis";
import type { ReadinessFinding } from "@/lib/audit/agent-readiness";

export interface ClosestWin {
  keyword: string;
  position: number;
  volume: number | null;
  /** Path on the visitor's site that currently earns the ranking. */
  path: string;
}

export interface GapTerm {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  /** Competitor domain(s) ranking for it, with their position. */
  rankedBy: { domain: string; position: number | null }[];
}

export interface PlanCadence {
  articlesPerMonth: number;
  /** Terms to write against first, in order. */
  firstTargets: string[];
  /** Working days from domain to first published article. */
  firstPublishDays: number;
}

export interface GrowthPlan {
  domain: string;
  generatedAt: string;
  /** DataForSEO's domain rank mapped to 0-100. Null when unmeasured. */
  authority: number | null;
  /** Estimated monthly organic visits. Null when unmeasured. */
  traffic: number | null;
  /** What the site publishes with, when it can be read off the homepage. */
  platform: string | null;
  rankingKeywords: number;
  closestWins: ClosestWin[];
  competitors: { domain: string; sharedKeywords: number }[];
  gaps: GapTerm[];
  readiness: {
    score: number;
    failing: { check: string; detail: string }[];
    artifacts: ReadinessArtifact[];
    error?: string;
  };
  cadence: PlanCadence;
  /** Which sources answered, so the UI can say "no rank data" instead of "0". */
  layers: { id: "ranked" | "competitors" | "gaps" | "readiness"; ok: boolean; detail: string }[];
}

const MAX_WINS = 5;
const MAX_GAPS = 8;
const RANKED_LIMIT = 200;
const COMPETITOR_RANKED_LIMIT = 300;
const COMPETITORS_TO_COMPARE = 2;
const MIN_SHARED_KEYWORDS = 20;

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

export const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

function pathOf(url: string | null): string {
  if (!url) return "/";
  try {
    return new URL(url, "https://placeholder.invalid").pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

/** Page-two terms the site already holds, biggest volume first. */
export function pickClosestWins(ranked: RankedKeyword[], limit = MAX_WINS): ClosestWin[] {
  // One win per page. The pitch is "one revision of this page", and a page
  // ranking 5th for three spellings of the same query is one revision, not
  // three. strikingDistance is volume-sorted, so the first term seen for a
  // path is its biggest.
  const seenPath = new Set<string>();
  const seenTerm = new Set<string>();
  const out: ClosestWin[] = [];
  for (const k of strikingDistance(ranked, { min: 5, max: 20 })) {
    if (k.position === null) continue;
    const path = pathOf(k.url);
    const term = k.keyword.toLowerCase();
    if (seenPath.has(path) || seenTerm.has(term)) continue;
    seenPath.add(path);
    seenTerm.add(term);
    out.push({ keyword: k.keyword, position: k.position, volume: k.volume, path });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Terms competitors rank for on page one that the target does not rank for at
 * all. Page one only: a term a competitor holds at position 80 says nothing
 * about whether it is winnable. Volume-sorted, because the visitor has a few
 * seconds and the biggest number is the one they check.
 */
/** "semrush.com" -> "semrush", so a term naming the competitor is excluded. */
function brandToken(domain: string): string {
  return domain.split(".")[0].toLowerCase();
}

const STOPWORDS = new Set([
  "what", "when", "where", "which", "with", "that", "this", "your", "from", "have",
  "does", "into", "best", "free", "online", "tool", "tools", "guide", "list", "make",
  "near", "more", "than", "then", "them", "they", "will", "about", "should", "how",
]);

function tokens(term: string): string[] {
  return term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/** A term is "about" one of the words the target already ranks for. */
function topicalFilter(own: RankedKeyword[]): (term: string) => boolean {
  const vocab = new Set(own.flatMap((k) => tokens(k.keyword)));
  return (term) => tokens(term).some((t) => vocab.has(t));
}

export function pickGaps(
  ranked: RankedKeyword[],
  competitorRanked: { domain: string; ranked: RankedKeyword[] }[],
  limit = MAX_GAPS,
): GapTerm[] {
  const own = new Set(ranked.map((k) => k.keyword.toLowerCase()));
  const brands = competitorRanked.map((c) => brandToken(c.domain)).filter((b) => b.length >= 3);
  // Semrush ranks first for a great deal that no site in the target's space
  // should write about. Without this, a small SEO blog's "gaps" were a list of
  // Semrush's stranger page-one terms. A gap has to share a word with something
  // the target already ranks for; that is a crude notion of topic, and it is
  // the right crudeness for a sixty-second check.
  const onTopic = topicalFilter(ranked);
  const byTerm = new Map<string, GapTerm>();
  for (const { domain, ranked: theirs } of competitorRanked) {
    for (const k of theirs) {
      const key = k.keyword.toLowerCase();
      if (own.has(key)) continue;
      if (k.position === null || k.position > 10) continue;
      // A competitor's own name is not a gap anyone should write toward.
      // Token-prefix match, so "ahref" and "ahrefs" are both the brand.
      if (key.split(/[^a-z0-9]+/).some((w) => brands.some((b) => w.startsWith(b) || (w.length >= 4 && b.startsWith(w))))) continue;
      if (!onTopic(key)) continue;
      const existing = byTerm.get(key);
      if (existing) {
        existing.rankedBy.push({ domain, position: k.position });
      } else {
        byTerm.set(key, {
          keyword: k.keyword,
          volume: k.volume,
          difficulty: k.difficulty,
          rankedBy: [{ domain, position: k.position }],
        });
      }
    }
  }
  // A term two competitors both hold on page one is a topic in the space. A
  // term only one holds is as likely to be that site's quirk (Semrush ranks
  // first for things no SEO tool should write about) as a gap. So intersections
  // lead, and singles only fill the remaining slots.
  const byVolume = (a: GapTerm, b: GapTerm) => (b.volume ?? 0) - (a.volume ?? 0);
  const candidates = [...byTerm.values()].filter((g) => (g.volume ?? 0) >= 50);
  const shared = candidates.filter((g) => g.rankedBy.length >= 2).sort(byVolume);
  const single = candidates.filter((g) => g.rankedBy.length < 2).sort(byVolume);
  return [...shared, ...single].slice(0, limit);
}

/**
 * What to publish, and in what order.
 *
 * TODO(mike): this is the one judgment call in the plan. The default below is
 * the weekly cadence the headline promises (four a month), wins before gaps
 * because a revision of a ranking page moves faster than a new article, and
 * five working days to the first one, which is the Monday-to-Friday claim.
 * Tune it here and the API, the homepage and the PDF all follow, because this
 * is the only place the number lives.
 */
export function planCadence(wins: ClosestWin[], gaps: GapTerm[]): PlanCadence {
  const articlesPerMonth = 4;
  const firstTargets = [...wins.map((w) => w.keyword), ...gaps.map((g) => g.keyword)].slice(
    0,
    articlesPerMonth,
  );
  return { articlesPerMonth, firstTargets, firstPublishDays: 5 };
}

export function summarizeFindings(findings: ReadinessFinding[]) {
  return findings
    .filter((f) => !f.passed)
    .sort((a, b) => {
      const w = { high: 0, medium: 1, low: 2 } as const;
      return w[a.severity] - w[b.severity];
    })
    .map((f) => ({ check: f.check, detail: f.detail }));
}

/** Injectable so the route can be tested without spending on DataForSEO. */
export interface PlanSources {
  ranked: (domain: string, limit: number) => Promise<RankedKeyword[]>;
  competitors: (domain: string) => Promise<OrganicCompetitor[]>;
  readiness: typeof buildReadinessReport;
  /**
   * The same first look the app runs on a workspace, at "quick" depth. One
   * code path means the free check on the marketing site and the analysis
   * inside the app cannot disagree about a domain, and the plan gets the
   * authority, traffic and platform the app already measures.
   */
  analysis?: (domain: string) => Promise<{ authority: number | null; traffic: number | null; platform: string | null }>;
}

const liveSources: PlanSources = {
  ranked: (domain, limit) => fetchRankedKeywords(domain, { limit }),
  competitors: (domain) => fetchOrganicCompetitors(domain, { limit: 10 }),
  readiness: buildReadinessReport,
  analysis: async (domain) => {
    const a = await analyseDomain({ domain, depth: "quick" });
    return { authority: a.authority, traffic: a.traffic, platform: a.platform };
  },
};

export async function buildGrowthPlan(
  rawDomain: string,
  sources: PlanSources = liveSources,
): Promise<GrowthPlan> {
  const domain = normalizeDomain(rawDomain);
  const layers: GrowthPlan["layers"] = [];

  // Readiness needs no paid API, so it runs alongside the rank lookups rather
  // than after them.
  const readinessP = sources.readiness(domain);
  // Runs alongside: the visitor is waiting, and neither call needs the other.
  const analysisP = sources.analysis?.(domain).catch(() => null) ?? Promise.resolve(null);

  let ranked: RankedKeyword[] = [];
  try {
    ranked = await sources.ranked(domain, RANKED_LIMIT);
    layers.push({ id: "ranked", ok: true, detail: `${ranked.length} ranking keywords found` });
  } catch (err) {
    layers.push({ id: "ranked", ok: false, detail: err instanceof Error ? err.message : "rank lookup failed" });
  }

  let competitors: OrganicCompetitor[] = [];
  let competitorRanked: { domain: string; ranked: RankedKeyword[] }[] = [];
  if (ranked.length) {
    try {
      // A "competitor" sharing five keywords with a site that ranks for seven
      // is noise: altorank.co's first run named an Airbnb ranking tool and
      // recommended Airbnb articles. Below the floor, say there is not enough
      // ranking history yet rather than compare against a coincidence.
      competitors = (await sources.competitors(domain))
        .filter((c) => c.sharedKeywords >= MIN_SHARED_KEYWORDS)
        .slice(0, COMPETITORS_TO_COMPARE);
      layers.push({
        id: "competitors",
        ok: competitors.length > 0,
        detail: competitors.length
          ? competitors.map((c) => c.domain).join(", ")
          : `no domain shares ${MIN_SHARED_KEYWORDS}+ ranking keywords with this site yet`,
      });
    } catch (err) {
      layers.push({ id: "competitors", ok: false, detail: err instanceof Error ? err.message : "competitor lookup failed" });
    }

    if (competitors.length) {
      const settled = await Promise.allSettled(
        competitors.map((c) => sources.ranked(c.domain, COMPETITOR_RANKED_LIMIT)),
      );
      competitorRanked = settled.flatMap((r, i) =>
        r.status === "fulfilled" ? [{ domain: competitors[i].domain, ranked: r.value }] : [],
      );
      layers.push({
        id: "gaps",
        ok: competitorRanked.length > 0,
        detail: `${competitorRanked.length} of ${competitors.length} competitor keyword sets fetched`,
      });
    }
  } else {
    layers.push({ id: "competitors", ok: false, detail: "skipped: no ranking keywords to compare" });
  }

  const closestWins = pickClosestWins(ranked);
  const gaps = pickGaps(ranked, competitorRanked);

  const [report, analysis] = await Promise.all([readinessP, analysisP]);
  layers.push({
    id: "readiness",
    ok: !report.error,
    detail: report.error ?? `score ${report.result.score}/100`,
  });

  return {
    domain,
    generatedAt: new Date().toISOString(),
    authority: analysis?.authority ?? null,
    traffic: analysis?.traffic ?? null,
    platform: analysis?.platform ?? null,
    rankingKeywords: ranked.length,
    closestWins,
    competitors: competitors.map((c) => ({ domain: c.domain, sharedKeywords: c.sharedKeywords })),
    gaps,
    readiness: {
      score: report.result.score,
      failing: summarizeFindings(report.result.findings),
      artifacts: report.artifacts,
      error: report.error,
    },
    cadence: planCadence(closestWins, gaps),
    layers,
  };
}
