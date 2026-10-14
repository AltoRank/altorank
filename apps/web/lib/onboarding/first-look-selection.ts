import { createHash } from "node:crypto";
import type { BusinessProfile } from "./profile-shape";
import type { Opportunity } from "@/lib/keyword-research/opportunity";
import { sameIntent } from "@/lib/keyword-research/intent";

export const FIRST_LOOK_CANDIDATE_LIMIT = 6;
export const BUYER_DECISIONS = ["cost", "choose-provider", "compare-approaches", "plan-project"] as const;
export type BuyerDecision = (typeof BUYER_DECISIONS)[number];
export interface FirstLookCandidate {
  term: string;
  offering: string;
  /** A verbatim passage in the site's read, not an inferred owner statement. */
  serviceQuote: string;
  decision: BuyerDecision;
  buyerDecision: string;
  intentId: string;
}
export interface FirstArticleEvidence extends FirstLookCandidate {
  version: 1;
  priority: "primary" | "secondary";
  rationale: string;
}
export interface ReviewedFirstLookCandidate extends FirstLookCandidate {
  priority: "primary" | "secondary";
  rationale: string;
}
const normal = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length <= max ? v.trim() : "";

/** Stable across query variants: one first-look intent per service and buying decision. */
export function firstLookIntentId(offering: string, decision: BuyerDecision): string {
  return createHash("sha256").update(`${normal(offering)}:${decision}`).digest("hex").slice(0, 24);
}

/** Evidence is checked against the read, not against the model's own confidence. */
export function parseFirstLookCandidates(raw: unknown, profile: BusinessProfile, siteText: string): FirstLookCandidate[] {
  if (!Array.isArray(raw)) return [];
  const allowed = profile.firstLookOffering ? [profile.firstLookOffering] : profile.offerings ?? [];
  const offerings = new Map(allowed.map((s) => [normal(s), s]));
  const seen = new Set<string>();
  const out: FirstLookCandidate[] = [];
  for (const row of raw.slice(0, FIRST_LOOK_CANDIDATE_LIMIT)) {
    if (!row || typeof row !== "object") continue;
    const term = text(row.term, 120);
    const offering = offerings.get(normal(text(row.offering, 200)));
    const serviceQuote = text(row.serviceQuote, 600);
    const buyerDecision = text(row.buyerDecision, 300);
    const decision = row.decision as BuyerDecision;
    if (term.length < 4 || !offering || serviceQuote.length < 24 || buyerDecision.length < 15 ||
      !BUYER_DECISIONS.includes(decision) || !normal(siteText).includes(normal(serviceQuote))) continue;
    const intentId = firstLookIntentId(offering, decision);
    if (seen.has(intentId) || out.some((c) => normal(c.term) === normal(term))) continue;
    seen.add(intentId);
    out.push({ term, offering, serviceQuote, decision, buyerDecision, intentId });
  }
  return out;
}

/** Missing, duplicate or incomplete review answers are refusals. */
export function applyFirstLookReview(raw: unknown, candidates: FirstLookCandidate[]): ReviewedFirstLookCandidate[] {
  if (!Array.isArray(raw)) return [];
  return candidates.flatMap((candidate) => {
    const matches = raw.filter((r) => r && typeof r === "object" && r.intentId === candidate.intentId);
    if (matches.length !== 1) return [];
    const r = matches[0];
    const rationale = text(r.rationale, 600);
    if (r.offered !== true || r.buyerDecision !== true || r.covered !== false || r.distinct !== true ||
      !["primary", "secondary"].includes(r.priority) || rationale.length < 20) return [];
    return [{ ...candidate, priority: r.priority, rationale }];
  });
}

export interface QualifiedFirstLookCandidate extends ReviewedFirstLookCandidate {
  id: string;
  volume: number | null;
  difficulty: number | null;
  impressions: number | null;
  opportunity?: Opportunity;
}

/** Service priority first; observed demand breaks ties, never manufactures eligibility. */
export function selectFirstLookCandidates(candidates: QualifiedFirstLookCandidate[], language: string): QualifiedFirstLookCandidate[] {
  const eligible = candidates.filter((c) => {
    const o = c.opportunity;
    return o?.status === "qualified" && o.funnel === "buyer" && !o.confidence && !o.floor && !o.existingUrl &&
      ["article", "mixed"].includes(o.format ?? "") &&
      new Set(o.evidenceUrls).size >= 2 && o.evidenceUrls?.every((u) => o.organicUrls?.includes(u));
  });
  eligible.sort((a, b) => Number(a.priority !== "primary") - Number(b.priority !== "primary") ||
    Math.min(5, b.opportunity!.evidenceUrls!.length) - Math.min(5, a.opportunity!.evidenceUrls!.length) ||
    (b.impressions ?? 0) - (a.impressions ?? 0) ||
    // Unknown has a neutral prior, not measured zero; demand is only the
    // fourth tie-breaker. A scalar keeps the ordering transitive.
    demandStrength(b.volume) - demandStrength(a.volume) || a.intentId.localeCompare(b.intentId));
  const selected: QualifiedFirstLookCandidate[] = [];
  for (const candidate of eligible) {
    if (selected.some((other) => candidate.intentId === other.intentId || sameIntent(
      { term: candidate.term, organicUrls: candidate.opportunity?.organicUrls ?? null },
      { term: other.term, organicUrls: other.opportunity?.organicUrls ?? null }, language,
    ).same)) continue;
    selected.push(candidate);
  }
  return selected;
}

function demandStrength(volume: number | null): number {
  return volume === null ? 0.5 : Math.min(1, Math.log10(1 + Math.max(0, volume)) / 4);
}
