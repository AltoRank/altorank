// ---------------------------------------------------------------------------
// Value first: which qualified topics make the plan, in what order, and which
// one is written first
// ---------------------------------------------------------------------------
//
// Until 2026-10 the plan was the qualified topics in volume order and the
// first article was simply the first of them, so a general-interest topic
// with a big volume outranked the owner's services, and a first article is
// the one a customer judges us by.
//
// So a topic's business value decides first, then how winnable it is, and
// volume only breaks ties (the order Ahrefs' Business Potential uses). The
// reader grades the value and names the service it relies on
// (lib/keyword-research/opportunity.ts); everything here is code, so the
// order is reproducible and testable, and the model never orders.
//
//   business value   3 the answer is one of the owner's services
//                    2 a problem a service solves, asked by a likely customer
//                    1 general interest in the field
//                    0 no path to the business: a veto, never planned
//                    Capped by code (`capValue`): no listed service named, or
//                    one the reader calls only adjacent to the search, caps
//                    it at 1; a service the search does not name itself caps
//                    it at 2. A profile with no service list is not capped:
//                    the grade stands, flagged, until services are listed.
//
//   tiers            T1  value >= 2 and winnable         at least 3 slots of 5
//                    T2  value 3, hard to win              at most 1 of 5
//                    T3  value 1, winnable: top of funnel   at most 1 of 5, and
//                        only in a plan of five or more unless relaxed
//                    everything else stays in inventory: qualified, kept,
//                    re-scored next run, never parked for it
//
//   within a tier    value (3 before 2), then winnability (an unmeasured
//                    term at 0.35 of its own), then volume, then the
//                    recommender's score
//
//   relaxing         when a first look cannot meet every rule: the service-
//                    page link falls back to the homepage (the reader's brief
//                    already does), the three revenue slots drop, then T1's
//                    share is filled, labelled lower confidence, from more
//                    T2, then from value-2 topics that are hard to win, and
//                    last from T3 - never past one top-of-funnel topic per
//                    five. The vetoes and the page type never relax: a
//                    needs_page or not_editorial topic is not a candidate.
//
//   first article    value >= 2, an editorial page, and no fact risk
//                    (./fact-risk.ts). When every such topic needs clinical,
//                    legal, financial or rules claims, the best one is
//                    written anyway, behind the approval gate, with a review
//                    note asking for the owner's input.
//
// Pure: no database, no model.

import type { Opportunity } from "./opportunity";
import { factRiskOf, namesYear, type FactRisk } from "./fact-risk";

export type BusinessValue = 0 | 1 | 2 | 3;
export type ValueTier = "t1" | "t2" | "t3" | "inventory";
export type PlannedTier = Exclude<ValueTier, "inventory">;

/** At most this many services go to the reader, as its enum. */
export const MAX_SERVICES = 12;

/** The services the reader names one of: the profile's offerings, trimmed, one of each. */
export function serviceList(business: { offerings?: string[] | null } | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of business?.offerings ?? []) {
    if (typeof raw !== "string") continue;
    const s = raw.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = s.toLowerCase();
    if (!s || key === "none" || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SERVICES) break;
  }
  return out;
}

/** The reader's grade, when it is one: an integer 0-3 (a numeric string is accepted). */
export function readValue(raw: unknown): BusinessValue | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 3 ? (n as BusinessValue) : null;
}

/**
 * How the search relates to the service the reader named: its words name
 * that service (or what it delivers, costs or is compared with), they name
 * a problem or situation the service is how a customer solves, or the
 * searcher wants a different service, technique or product that a listed
 * one is only related to.
 */
export type ServiceMatch = "named" | "implied" | "adjacent";
export const SERVICE_MATCHES: readonly ServiceMatch[] = ["named", "implied", "adjacent"];

export function readMatch(raw: unknown): ServiceMatch | null {
  return typeof raw === "string" && (SERVICE_MATCHES as readonly string[]).includes(raw) ? (raw as ServiceMatch) : null;
}

/** Why code lowered a grade: no listed service named, only an adjacent one, or one the search does not name. */
export type ValueCap = "no_service" | "adjacent" | "implied";

export interface KeptValue {
  value: BusinessValue;
  /** The listed service the grade rests on; null when none was named or it was only adjacent. */
  service: string | null;
  capped: boolean;
  cap?: ValueCap;
  /** No service list to grade against: the grade stands as given, and the run says so. */
  unlisted?: true;
}

/**
 * The grade as code keeps it. The reader must point at a listed service
 * and say how the search reaches it, and code holds it to that:
 *
 *   no listed service named           capped at 1: a value nobody can point at
 *   the service is only adjacent      capped at 1: the business does not sell
 *                                     what is asked (a related technique, a
 *                                     product it could build or mention)
 *   the search does not name it       capped at 2: the answer is a service
 *                                     only when the search asks for it
 *
 * The enum alone never closed this: a reader can always name some listed
 * service, so "which" is not enough without "how".
 *
 * A profile with no service list is not capped at all (every grade would be
 * 1, the tiers empty, and the first article gone with nothing said): the
 * grade stands, flagged `unlisted`, and the run counts it.
 */
export function capValue(graded: BusinessValue, named: unknown, services: readonly string[], match?: ServiceMatch | null): KeptValue {
  if (!services.length) return { value: graded, service: null, capped: false, unlisted: true };
  const said = typeof named === "string" ? named.trim().toLowerCase() : "";
  const service = said && said !== "none" ? services.find((s) => s.toLowerCase() === said) ?? null : null;
  if (!service) return graded > 1 ? { value: 1, service: null, capped: true, cap: "no_service" } : { value: graded, service: null, capped: false };
  if (match === "adjacent" && graded > 1) return { value: 1, service: null, capped: true, cap: "adjacent" };
  if (match !== "named" && graded > 2) return { value: 2, service, capped: true, cap: "implied" };
  return { value: graded, service, capped: false };
}

/**
 * An approval the #263 floor wrote (until 2026-10): a not_editorial page
 * promoted into a short plan. The page type never relaxes now, so it is not
 * an approval the planner takes; it is judged again when its verdict ages out.
 */
export function retiredFloorApproval(o: Pick<Opportunity, "status" | "confidence" | "reason"> | null | undefined): boolean {
  return o?.status === "qualified" && o.confidence === "lower" && typeof o.reason === "string" && o.reason.startsWith("Lower confidence: fewer articles hold this search");
}

/** A verdict's value for ordering. Ungraded (saved before grades existed) reads as 1: no service was named. */
export function valueOf(o: Pick<Opportunity, "value"> | null | undefined): BusinessValue {
  return readValue(o?.value) ?? 1;
}

/**
 * Winnability (lib/seo/difficulty.ts) at or above this is "winnable". 0.5 is
 * KD 50 on a site of unknown authority, or a gap of 50 points between what
 * the results page demands and the site's authority; an unknown difficulty
 * (0.6) counts as winnable. To be tuned on the eval, which stores KD and
 * authority where they were captured (lib/evals/types.ts).
 */
export const WINNABLE_AT = 0.5;
/** What an unmeasured term's winnability counts for within its tier (founder decision, 2026-09-30). */
export const UNMEASURED_WEIGHT = 0.35;

export function tierOf(value: BusinessValue, winnability: number): ValueTier {
  const winnable = winnability >= WINNABLE_AT;
  if (value >= 2 && winnable) return "t1";
  if (value === 3) return "t2";
  if (value === 1 && winnable) return "t3";
  return "inventory";
}

/** What ordering reads from a topic. */
export interface Rankable {
  term: string;
  value: BusinessValue;
  /** lib/seo/difficulty.ts `winnability`, 0-1. */
  winnability: number;
  volume: number | null;
  /** No measured demand: its winnability counts at UNMEASURED_WEIGHT within its tier. */
  unmeasured?: boolean;
  /** The recommender's score, the last tie-break before the words. */
  score?: number;
}

/** What the value tiers read from a recommendation (lib/seo/recommendations.ts). */
export function rankOf(rec: {
  term: string;
  winnability: number;
  volume: number | null;
  demand?: "unmeasured";
  score?: number;
  opportunity?: Pick<Opportunity, "value" | "demand"> | null;
}): Rankable {
  return {
    term: rec.term,
    value: valueOf(rec.opportunity),
    winnability: rec.winnability,
    volume: rec.volume,
    unmeasured: rec.demand === "unmeasured" || rec.opportunity?.demand === "unmeasured",
    score: rec.score,
  };
}

const TIER_RANK: Record<ValueTier, number> = { t1: 0, t2: 1, t3: 2, inventory: 3 };

/** Winnability as the within-tier key: weighted, in tenths, so volume can break a tie. */
export function reachKey(r: Pick<Rankable, "winnability" | "unmeasured">): number {
  return Math.round(r.winnability * (r.unmeasured ? UNMEASURED_WEIGHT : 1) * 10) / 10;
}

/**
 * Tier, then value (3 before 2: within T1 a service itself outranks a
 * problem it solves, whatever the volume), then winnability, then volume,
 * then score, then the words: the planner's order.
 */
export function planOrder(a: Rankable, b: Rankable): number {
  return TIER_RANK[tierOf(a.value, a.winnability)] - TIER_RANK[tierOf(b.value, b.winnability)]
    || b.value - a.value
    || reachKey(b) - reachKey(a)
    || (b.volume ?? -1) - (a.volume ?? -1)
    || (b.score ?? 0) - (a.score ?? 0)
    || a.term.localeCompare(b.term);
}

/**
 * An approval the planner can take: qualified, not saved by the retired
 * floor, and in a value tier rather than inventory. The one test the plan,
 * the queue's refill, the research top-up, the cron's "is anything left"
 * and the trial screen's held count all ask, so none of them counts as
 * ready what the planner will not plan.
 */
export function plannableApproval(o: Pick<Opportunity, "status" | "confidence" | "reason" | "value"> | null | undefined, reach: number): boolean {
  return o?.status === "qualified" && !retiredFloorApproval(o) && tierOf(valueOf(o), reach) !== "inventory";
}

// ── The plan ──────────────────────────────────────────────────────────────

export interface PlanRules {
  /** Topics the plan may hold (a first look: 5). */
  slots: number;
  /**
   * Whether the rules may relax to fill T1's share (a first look only: a
   * nightly top-up plans what the rules admit, and nothing lower).
   */
  relax: boolean;
}

/**
 * T1's share and the T2 and T3 caps, for a plan of `slots`: 3, 1 and 1 of 5.
 * `t3` is what the tier takes on its own: none in a plan of fewer than five,
 * so a one-slot plan is never all top of funnel. `t3Total` bounds it with
 * relaxed picks included: one per five, and one in a shorter plan.
 */
export function tierCaps(slots: number): { revenue: number; t2: number; t3: number; t3Total: number } {
  const n = Math.max(0, Math.floor(slots));
  const share = Math.floor(n / 5);
  return { revenue: Math.min(n, Math.ceil((n * 3) / 5)), t2: Math.max(1, share), t3: share, t3Total: Math.max(1, share) };
}

/** Why a qualified topic was not planned: its tier admits none this run, its tier was full, or the plan was. */
export type Unplanned = "inventory" | "tier_full" | "no_room";
/** What a plan relaxed to be made: the revenue-slot rule dropped, and lower-confidence picks added. */
export type Relaxation = "revenue_slots" | "lower_confidence";

export interface PlanPick<T> {
  item: T;
  tier: PlannedTier;
  /** Taken past its tier's cap to fill T1's share: "Lower confidence". */
  relaxed: boolean;
}

export interface PlanSelection<T> {
  picks: PlanPick<T>[];
  left: Array<{ item: T; why: Unplanned }>;
  relaxations: Relaxation[];
}

/**
 * The plan from the qualified topics: T1 first, then at most the T2 and T3
 * caps, then - a first look only, and only while T1 is short of its share -
 * more T2, then value-2 topics hard to win (inventory otherwise), then T3
 * up to its total cap, each labelled relaxed. In plan order: tier, then
 * relaxed after not, then the planner's order. `items` should already be
 * one per search; nothing here compares searches.
 */
export function selectPlan<T>(items: readonly T[], read: (item: T) => Rankable, rules: PlanRules): PlanSelection<T> {
  const ranked = items.map((item) => ({ item, r: read(item) })).sort((a, b) => planOrder(a.r, b.r));
  const byTier = (tier: ValueTier) => ranked.filter((x) => tierOf(x.r.value, x.r.winnability) === tier);
  const caps = tierCaps(rules.slots);
  const picks: Array<PlanPick<T> & { order: number }> = [];
  const taken = new Set<T>();
  const room = () => rules.slots - picks.length;
  const take = (list: typeof ranked, tier: PlannedTier, n: number, relaxed: boolean) => {
    for (const x of list) {
      if (n <= 0 || room() <= 0) break;
      if (taken.has(x.item)) continue;
      taken.add(x.item);
      picks.push({ item: x.item, tier, relaxed, order: ranked.indexOf(x) });
      n--;
    }
  };
  const pickedOf = (tier: PlannedTier) => picks.filter((p) => p.tier === tier).length;
  const t1 = byTier("t1"), t2 = byTier("t2"), t3 = byTier("t3");
  // Value 2 and hard to win: a problem a service solves, out of reach for
  // now. Inventory unless a first look is short of T1's share.
  const hardValue = byTier("inventory").filter((x) => x.r.value >= 2);
  take(t1, "t1", rules.slots, false);
  take(t2, "t2", caps.t2, false);
  take(t3, "t3", caps.t3, false);
  const relaxations: Relaxation[] = [];
  if (rules.relax) {
    const revenue = picks.filter((p) => p.tier !== "t3").length;
    if (revenue < caps.revenue && ranked.length) relaxations.push("revenue_slots");
    const short = () => caps.revenue - pickedOf("t1") - picks.filter((p) => p.relaxed).length;
    if (short() > 0) {
      const before = picks.length;
      take(t2, "t2", short(), true);
      take(hardValue, "t2", short(), true);
      take(t3, "t3", Math.min(short(), caps.t3Total - pickedOf("t3")), true);
      if (picks.length > before) relaxations.push("lower_confidence");
    }
  }
  picks.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || Number(a.relaxed) - Number(b.relaxed) || a.order - b.order);
  // A T2 or T3 left out once its tier's cap was taken is out by the cap,
  // full plan or not; anything else ran out of room.
  const left = ranked.filter((x) => !taken.has(x.item)).map((x) => {
    const tier = tierOf(x.r.value, x.r.winnability);
    const why: Unplanned = tier === "inventory" ? "inventory" : tier !== "t1" && pickedOf(tier) >= caps[tier] ? "tier_full" : "no_room";
    return { item: x.item, why };
  });
  return { picks: picks.map(({ order: _order, ...p }) => { void _order; return p; }), left, relaxations };
}

// ── The first article ─────────────────────────────────────────────────────

export type FirstArticleRule = "rule" | "fact_risk_fallback" | "none";

export interface FirstArticleChoice<T> {
  pick: T | null;
  rule: FirstArticleRule;
  /** The fact risk the pick carries, when the fallback chose it. */
  risk: FactRisk | null;
  /** The phrase names a year: the article is refreshed every year. */
  refreshYearly: boolean;
  /** For the draft's review notes: what a person has to do before publishing. */
  notes: string[];
  /** One sentence for the run's log: why this one, or why none. */
  why: string;
}

/** A verdict the first article may be written on: approved on an editorial page, value 2 or more. */
export function firstArticleEligible(o: Opportunity | null | undefined): boolean {
  return o?.status === "qualified" && (o.format === "article" || o.format === "mixed") && valueOf(o) >= 2 && !retiredFloorApproval(o);
}

const RISK_WORDS: Record<FactRisk["kind"], string> = {
  health: "clinical",
  legal: "legal",
  financial: "financial",
  safety: "safety",
  regulation: "regulatory",
  incentive: "incentive-scheme",
};

/**
 * Which planned topic is written first, in plan order: the first that
 * passes the rule; else, when every topic of value 2 or more carries a fact
 * risk, the first of those, with a note asking for the owner's input; else
 * none, and the run says why rather than writing a general-interest article.
 */
export function chooseFirstArticle<T>(
  items: readonly T[],
  read: (item: T) => { term: string; brief?: Opportunity | null },
  context: { language?: string | null } = {},
): FirstArticleChoice<T> {
  const eligible = items.map((item) => ({ item, ...read(item) })).filter((x) => firstArticleEligible(x.brief));
  const risks = eligible.map((x) => factRiskOf({ term: x.term, angle: x.brief?.angle, language: context.language }));
  const yearly = (term: string) => namesYear(term);
  const yearNote = "The topic names a year: refresh this article every year.";
  const clean = eligible.findIndex((_, i) => !risks[i]);
  if (clean >= 0) {
    const x = eligible[clean];
    return { pick: x.item, rule: "rule", risk: null, refreshYearly: yearly(x.term), notes: yearly(x.term) ? [yearNote] : [], why: `"${x.term}": business value ${valueOf(x.brief)}, an editorial results page, no claims that need the owner's facts.` };
  }
  if (eligible.length) {
    const x = eligible[0];
    const risk = risks[0]!;
    const words = RISK_WORDS[risk.kind];
    const note = `Needs your input before publishing: every planned topic about your services asks for ${words} claims, so this one was written anyway (${risk.evidence}). Check each ${words} statement against what you would tell a client yourself, and correct or remove any you would not make.`;
    return {
      pick: x.item, rule: "fact_risk_fallback", risk, refreshYearly: yearly(x.term),
      notes: [note, ...(yearly(x.term) ? [yearNote] : [])],
      why: `"${x.term}": every planned topic of value 2 or more needs ${words} claims; the best one is written for the owner to check.`,
    };
  }
  return { pick: null, rule: "none", risk: null, refreshYearly: false, notes: [], why: "No planned topic is about one of your services closely enough (business value 2 or more, on an editorial results page) to be the first article." };
}
