// ---------------------------------------------------------------------------
// What to do about the visibility numbers
// ---------------------------------------------------------------------------
//
// Measuring that a brand is cited 0% of the time is a scoreboard. It tells the
// client they are losing and not one thing to do about it, which is the failure
// mode of every AI-visibility tool on the market: a dashboard that produces
// anxiety and no next step.
//
// This turns a sweep into a ranked list of actions, each tied to the evidence
// that produced it. Deterministic, like the keyword recommender and for the
// same reason: the client will ask "why are you telling me to do this", and the
// answer has to be a fact from their own data rather than a model's opinion.
//
// Every action is something the product can either do itself or hand to a human
// with the work already prepared. An action nobody can execute is another
// scoreboard.

import type { GeoResultRow } from "@/lib/queries/geo";

export type GeoActionKind =
  | "cover_prompt"
  | "earn_citation"
  | "fix_readiness"
  | "answer_fan_out"
  | "defend_position";

export interface GeoAction {
  kind: GeoActionKind;
  /** Imperative, specific, and safe to show a client. */
  title: string;
  detail: string;
  /** The measurement this came from, so the advice can be checked. */
  evidence: string;
  /** Higher runs first. Relative only. */
  priority: number;
  /** Where the product can take this on automatically. */
  automatable: boolean;
}

/** Domains that are never a competitor worth chasing. */
const INFRASTRUCTURE = [
  "vertexaisearch.cloud.google.com",
  "google.com",
  "bing.com",
  "duckduckgo.com",
];

function isInfrastructure(domain: string): boolean {
  return INFRASTRUCTURE.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Derive the next moves from one visibility sweep.
 *
 * `readinessScore` is optional and only used to decide whether a citation
 * problem is really a crawlability problem: being uncitable is a plausible
 * cause of not being cited, and telling someone to write more content when an
 * AI cannot read their site at all is the wrong instruction.
 */
export function deriveGeoActions(options: {
  rows: GeoResultRow[];
  brandDomain: string;
  readinessScore?: number | null;
}): GeoAction[] {
  const { rows, brandDomain, readinessScore } = options;
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) return [];

  const actions: GeoAction[] = [];

  // --- Prompts where the brand never appears ------------------------------
  // The sharpest signal available: a specific question, asked of every engine,
  // that never returns this brand.
  const byPrompt = new Map<string, GeoResultRow[]>();
  for (const r of ok) {
    byPrompt.set(r.prompt, [...(byPrompt.get(r.prompt) ?? []), r]);
  }

  for (const [prompt, results] of byPrompt) {
    const named = results.filter((r) => r.mentioned).length;
    if (named === 0) {
      // Who won this specific question, rather than in aggregate. The pages an
      // engine cited for one prompt are the brief for beating it.
      const winners = [
        ...new Set(results.flatMap((r) => r.competitor_domains ?? []).filter((d) => !isInfrastructure(d))),
      ].slice(0, 3);

      actions.push({
        kind: "cover_prompt",
        title: `Publish an answer to "${prompt}"`,
        detail: winners.length
          ? `No engine named this brand for this question. ${winners.join(", ")} were cited instead, so those pages are the standard to beat. Generate a page that answers it directly and completely.`
          : "No engine named this brand for this question, and none cited a clear source, which usually means the answer is being assembled from general knowledge. A single direct, well-structured answer can claim it.",
        evidence: `Named in 0 of ${results.length} answers across ${new Set(results.map((r) => r.engine)).size} engines`,
        priority: 100,
        automatable: true,
      });
    } else if (named < results.length) {
      const missing = results.filter((r) => !r.mentioned).map((r) => r.engine);
      actions.push({
        kind: "defend_position",
        title: `Close the gap on ${missing.join(" and ")}`,
        detail: `The brand is named for this question on some engines but not all. Engines differ in what they index and how recently, so this is usually a freshness or structured-data gap rather than a content gap.`,
        evidence: `Named in ${named} of ${results.length} answers; missing on ${missing.join(", ")}`,
        priority: 60,
        automatable: false,
      });
    }
  }

  // --- Mentioned but not cited --------------------------------------------
  // Being named without a link means the model knows the brand but is not
  // reading the site, which is a different and cheaper problem to fix.
  const mentionedNotCited = ok.filter((r) => r.mentioned && !r.cited).length;
  if (mentionedNotCited > 0) {
    actions.push({
      kind: "earn_citation",
      title: "Turn mentions into citations",
      detail:
        "Answers name the brand without linking to it, so the model is recalling it rather than reading it. Publishing the specific, quotable claim on a crawlable page is what converts a mention into a citation.",
      evidence: `${mentionedNotCited} answers mentioned the brand without citing its domain`,
      priority: 80,
      automatable: true,
    });
  }

  // --- Not readable at all -------------------------------------------------
  const citedAnywhere = ok.some((r) => r.cited);
  if (!citedAnywhere && typeof readinessScore === "number" && readinessScore < 70) {
    actions.push({
      kind: "fix_readiness",
      title: "Fix agent readiness before writing more",
      detail:
        "The site is cited in no answer and scores poorly on agent readiness. More content will not help while an AI cannot reliably crawl, parse or attribute the pages that already exist. Fix the readiness failures first.",
      evidence: `Agent readiness ${readinessScore}/100 and 0 citations across ${ok.length} answers`,
      priority: 120,
      automatable: true,
    });
  }

  // --- Questions the engines actually asked --------------------------------
  // Fan-out queries are the searches a model ran to ground its answer. They are
  // real retrieval intent, not keyword-tool estimates.
  const fanOut = new Map<string, number>();
  for (const r of ok) {
    for (const q of r.fan_out_queries ?? []) {
      const key = q.trim().toLowerCase();
      if (key) fanOut.set(key, (fanOut.get(key) ?? 0) + 1);
    }
  }
  const topFanOut = [...fanOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topFanOut.length) {
    actions.push({
      kind: "answer_fan_out",
      title: "Target the searches the engines actually run",
      detail: `Before answering, the engines searched for: ${topFanOut
        .map(([q]) => `"${q}"`)
        .join(", ")}. These are retrieval queries rather than estimates, so a page that answers them is a page an engine will find while grounding its next answer.`,
      evidence: `${fanOut.size} distinct grounding searches observed across ${ok.length} answers`,
      priority: 70,
      automatable: true,
    });
  }

  // --- Who to displace -----------------------------------------------------
  const domainCounts = new Map<string, number>();
  for (const r of ok) {
    for (const d of r.competitor_domains ?? []) {
      if (!isInfrastructure(d)) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
  }
  const top = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 1) {
    actions.push({
      kind: "earn_citation",
      title: `Study ${top[0]}, the most cited source`,
      detail:
        "The most frequently cited domain across these prompts is the closest thing to a template for what these engines consider authoritative on this topic. Match its coverage and structure, then exceed its specificity.",
      evidence: `Cited in ${top[1]} of ${ok.length} answers, more than any other domain`,
      priority: 50,
      automatable: false,
    });
  }

  return actions.sort((a, b) => b.priority - a.priority);
}

/** Ignores the brand's own domain when tallying competitors. */
export function stripOwnDomain(domains: string[], brandDomain: string): string[] {
  const own = brandDomain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
  return domains.filter((d) => d !== own && !d.endsWith(`.${own}`));
}
