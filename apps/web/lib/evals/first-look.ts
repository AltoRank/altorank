// ---------------------------------------------------------------------------
// First-look yield: does a signup end with one planned article?
// ---------------------------------------------------------------------------
//
// The other decisions here score one judgement at a time. None of them could
// have said that four signups in one evening planned nothing (2026-11-16):
// every single judgement in those runs was defensible, and the run as a
// whole still ended with no article. This replays a first look end to end -
// what was typed at signup, the profile the site gave (or the owner's answer
// when it gave none), the model's stored answers and the stored results
// pages - through the product's own code, and reports:
//
//   yield        the share of cases with a usable profile that planned an
//                article the writer accepts
//   rungs        which rung of the planner planned it
//                (lib/onboarding/first-look-plan.ts)
//   nothing      the cases that planned nothing, with the reason
//   floor picks  for the picks made below the bar, a second label: would
//                the owner publish this topic? A guarantee met with junk
//                shows up here.
//
// Free and deterministic in every mode: no model, no provider, no database.
// A case holds its model answers by ask, not by prompt hash, because what is
// under test is the planner's path through them, not the prompt.
//
// Cases:   <dir>/first-look/*.json           one FirstLookCase each
// Labels:  <dir>/first-look-labels/*.json    arrays of FloorLabel
//
// The sample under fixtures/sample is invented. Real runs are exported from
// `first_look_replays` (migration 123) into a private directory.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { profileFromAnswer, profileUsable } from "@/lib/keyword-research/business-context";
import type { FitProfile } from "@/lib/keyword-research/buyer-fit";
import { HARD_REJECT_WORDS, type FirstLookRung, type HardReject } from "@/lib/keyword-research/first-look-topics";
import { contextKey, readOpportunity } from "@/lib/keyword-research/opportunity";
import { resolveOwnSite } from "@/lib/domain/own-site";
import { DOMAIN_PATTERN } from "@/lib/domain/shape";
import { planFirstLook } from "@/lib/onboarding/first-look-plan";
import type { SerpData } from "@/lib/seo/brief-data";
import { memoryDb } from "./memory-db";
import type { Scored } from "./types";

export interface FirstLookCase {
  id: string;
  /** What was typed in the website field at signup. */
  url: string;
  /** Where a share link's redirect leads, by the link requested. A link not listed leads nowhere. */
  redirects?: Record<string, string>;
  languageCode: string;
  locationCode: number;
  /** The date the plan is made on. */
  today: string;
  /** The site's authority, when measured. */
  authority?: number | null;
  /** The profile read off the site. Null: it had too little text to read one from. */
  business: (FitProfile & { conversionUrl?: string | null }) | null;
  /** What the owner typed when asked "what do you sell, and to whom?". */
  ownerAnswer?: { description?: string; offerings?: string[]; audiences?: string[] } | null;
  /** The site's own pages. */
  pages?: Array<{ title: string; path: string }>;
  /** The searches research had stored for the site. */
  pool?: Array<{ term: string; volume: number | null; difficulty: number | null }>;
  /** The model's stored answers, raw (a reply cut off at its token limit is stored cut off). Null: it did not answer. */
  answers: { suggest: string | null; secondAsk?: string | null };
  /** The stored results pages, by search. A search not listed is a provider that did not answer. */
  serps: Record<string, SerpData["organic"]>;
  /** The label: the site gave us (or its owner told us) enough to plan from. */
  usableProfile: boolean;
  /** What should happen, for the cases whose point is something other than a plan. */
  expect?: { refused?: boolean; rung?: FirstLookRung };
  note?: string;
}

/** A person's answer to "would the owner publish this topic?", for a pick made below the bar. */
export interface FloorLabel {
  caseId: string;
  term: string;
  publish: "yes" | "no";
  note?: string;
}

export type FirstLookEnding =
  /** An article is on the calendar with a brief the writer accepts. */
  | "planned"
  /** A topic was proposed to the owner: one click from an article, and not one yet. */
  | "proposed"
  /** What was typed is not the business's own site. */
  | "refused"
  /** Nothing says what the business sells. */
  | "needs_business"
  | "nothing";

export interface FirstLookRun {
  caseId: string;
  usableProfile: boolean;
  ending: FirstLookEnding;
  /** The planned or proposed search. */
  term?: string;
  rung?: FirstLookRung;
  /** Lower confidence, as the brief says it. */
  lower?: boolean;
  /** For anything but `planned`: why, in a sentence. */
  reason?: string;
  resultsRead: number;
  modelCalls: number;
}

/** The rungs below the bar: the picks the second label set is about. */
const FLOOR_RUNGS: readonly FirstLookRung[] = ["second_ask", "floor", "related_evidence", "uncited"];
export const isFloorPick = (run: Pick<FirstLookRun, "ending" | "rung">): boolean =>
  run.ending === "proposed" || (run.ending === "planned" && FLOOR_RUNGS.includes(run.rung ?? "ranked"));

function jsonIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
}

export function loadFirstLookCases(dir: string): FirstLookCase[] {
  return jsonIn(path.join(dir, "first-look")).map((file) => JSON.parse(readFileSync(file, "utf8")) as FirstLookCase);
}

export function loadFloorLabels(dir: string): FloorLabel[] {
  return jsonIn(path.join(dir, "first-look-labels")).flatMap((file) => JSON.parse(readFileSync(file, "utf8")) as FloorLabel[]);
}

/** One signup, from the website field to the plan, on stored answers. */
export async function runFirstLookCase(c: FirstLookCase): Promise<FirstLookRun> {
  const base = { caseId: c.id, usableProfile: c.usableProfile, resultsRead: 0, modelCalls: 0 };

  // The website field (lib/domain/own-site.ts), with the case's redirects
  // standing in for the network.
  const own = await resolveOwnSite(c.url, {
    fetch: async (url) => {
      const to = c.redirects?.[url];
      return to ? new Response(null, { status: 302, headers: { location: to } }) : new Response("", { status: 200 });
    },
  });
  if (!own.ok) return { ...base, ending: "refused", reason: own.reason };
  if (!DOMAIN_PATTERN.test(own.domain)) return { ...base, ending: "refused", reason: "Not a domain." };

  // The profile: the site's, or the owner's answer made usable.
  const answered = c.ownerAnswer ? { ...(c.business ?? {}), ...c.ownerAnswer } : c.business;
  const business = profileUsable(c.business) ? c.business : profileFromAnswer(answered, own.domain);
  if (!business || !profileUsable(business)) return { ...base, ending: "needs_business", reason: "The site had too little text to read a profile from, and its owner was not asked or did not answer." };

  const workspaceId = `ws-${c.id}`;
  const { db, tables } = memoryDb({
    workspaces: [{ id: workspaceId, domain: own.domain, language: c.languageCode, location_code: c.locationCode, dr: c.authority ?? null, business_profile: business }],
    site_pages: (c.pages ?? []).map((p) => ({ workspace_id: workspaceId, url: `https://${own.domain}${p.path}`, path: p.path, title: p.title, h1: null })),
    keywords: (c.pool ?? []).map((k, i) => ({ id: `pool-${i}`, workspace_id: workspaceId, term: k.term, volume: k.volume, difficulty: k.difficulty, status: "new", plan_excluded_at: null, source_url: null, opportunity: null })),
  });
  const out = await planFirstLook(db, workspaceId, {
    firstLook: { serps: new Map() },
    weeklyLimit: 2,
    now: new Date(`${c.today}T12:00:00Z`),
    // Before the trial: one article, as a signup gets.
    hold: async () => "held",
    decorate: false,
    rivalPages: async () => [],
    metrics: async () => new Map(),
    ask: async (operation) => (operation.endsWith("second-ask") ? c.answers.secondAsk ?? null : c.answers.suggest),
    serp: async (term) => {
      const organic = c.serps[term];
      if (!organic) throw new Error(`No stored results page for "${term}".`);
      return { organic, peopleAlsoAsk: [], aiOverview: null };
    },
  });
  const counts = { resultsRead: out.summary.resultsRead, modelCalls: out.summary.modelCalls };
  const removed = Object.entries(out.summary.rejected).map(([k, n]) => `${n} ${HARD_REJECT_WORDS[k as HardReject]}`).join(", ");
  const read = `${out.summary.suggested} suggested${out.summary.secondAsk ? `, ${out.summary.secondAsk.suggested} more on the second ask` : ""}, ${out.summary.resultsRead} results pages read${removed ? `, removed ${removed}` : ""}${out.summary.noEvidence ? `, ${out.summary.noEvidence} with nothing to cite` : ""}`;

  if (out.outcome === "needs_owner_input" && out.proposal) {
    return { ...base, ...counts, ending: "proposed", term: out.proposal.term, reason: `No topic could be planned with evidence the writer accepts (${read}); one was proposed to the owner.` };
  }
  if (out.outcome !== "planned" || !out.plan.length) {
    return { ...base, ...counts, ending: "nothing", reason: `${out.outcome}: ${read}.` };
  }
  // Planned means the writer would write it: the brief on the row passes
  // the check an automatic draft makes (`readOpportunity`).
  const first = out.plan[0];
  const row = tables.keywords.find((k) => k.id === first.keywordId);
  const fingerprint = contextKey({ business, domain: own.domain, languageCode: c.languageCode, locationCode: c.locationCode });
  // The age check is against today's clock: read the brief as of the case's date.
  const brief = readOpportunity(row?.opportunity ? { ...(row.opportunity as object), checkedAt: new Date().toISOString() } : null, fingerprint);
  if (brief?.status !== "qualified") {
    return { ...base, ...counts, ending: "nothing", term: first.term, reason: "A topic was planned with a brief the writer's own check refuses." };
  }
  return { ...base, ...counts, ending: "planned", term: first.term, rung: out.summary.rung ?? "ranked", ...(brief.confidence === "lower" ? { lower: true } : {}) };
}

export interface FirstLookReport {
  cases: number;
  /** Cases labelled as having a usable profile: the yield's denominator. */
  usable: number;
  /** Of those, the ones that planned an article. */
  planned: number;
  /** planned / usable; null with no usable case. */
  yield: number | null;
  /** Of those, a topic proposed to the owner and nothing planned. */
  proposed: number;
  byRung: Partial<Record<FirstLookRung, number>>;
  /** Usable-profile cases with no planned article, and why. */
  nothing: Array<{ caseId: string; ending: FirstLookEnding; reason: string }>;
  /** Cases with no usable profile, and how they ended (a refused link, an unanswered question). */
  notUsable: Array<{ caseId: string; ending: FirstLookEnding; reason: string }>;
  /** The second label set: picks made below the bar, by whether the owner would publish them. */
  floor: { picks: number; yes: number; no: number; unlabelled: number; rejected: Array<{ caseId: string; term: string; note: string }>; missing: Array<{ caseId: string; term: string }> };
  /** Cases whose `expect` did not hold. */
  unexpected: Array<{ caseId: string; expected: string; got: string }>;
  runs: FirstLookRun[];
}

export function firstLookReport(cases: readonly FirstLookCase[], runs: readonly FirstLookRun[], labels: readonly FloorLabel[]): FirstLookReport {
  const usable = runs.filter((r) => r.usableProfile);
  const planned = usable.filter((r) => r.ending === "planned");
  const byRung: FirstLookReport["byRung"] = {};
  for (const r of planned) byRung[r.rung ?? "ranked"] = (byRung[r.rung ?? "ranked"] ?? 0) + 1;
  const labelOf = (r: FirstLookRun) => labels.find((l) => l.caseId === r.caseId && l.term.trim().toLowerCase() === (r.term ?? "").trim().toLowerCase());
  const picks = usable.filter(isFloorPick);
  const unexpected: FirstLookReport["unexpected"] = [];
  for (const c of cases) {
    const r = runs.find((x) => x.caseId === c.id);
    if (!r || !c.expect) continue;
    if (c.expect.refused !== undefined && c.expect.refused !== (r.ending === "refused")) unexpected.push({ caseId: c.id, expected: c.expect.refused ? "refused" : "accepted", got: r.ending });
    if (c.expect.rung && c.expect.rung !== r.rung) unexpected.push({ caseId: c.id, expected: `rung ${c.expect.rung}`, got: r.rung ? `rung ${r.rung}` : r.ending });
  }
  const why = (r: FirstLookRun) => ({ caseId: r.caseId, ending: r.ending, reason: r.reason ?? "" });
  return {
    cases: runs.length,
    usable: usable.length,
    planned: planned.length,
    yield: usable.length ? planned.length / usable.length : null,
    proposed: usable.filter((r) => r.ending === "proposed").length,
    byRung,
    nothing: usable.filter((r) => r.ending !== "planned").map(why),
    notUsable: runs.filter((r) => !r.usableProfile).map(why),
    floor: {
      picks: picks.length,
      yes: picks.filter((r) => labelOf(r)?.publish === "yes").length,
      no: picks.filter((r) => labelOf(r)?.publish === "no").length,
      unlabelled: picks.filter((r) => !labelOf(r)).length,
      rejected: picks.filter((r) => labelOf(r)?.publish === "no").map((r) => ({ caseId: r.caseId, term: r.term ?? "", note: labelOf(r)?.note ?? "" })),
      missing: picks.filter((r) => !labelOf(r)).map((r) => ({ caseId: r.caseId, term: r.term ?? "" })),
    },
    unexpected,
    runs: [...runs],
  };
}

/**
 * What `--require-complete` holds a case set to: every usable-profile case
 * planned an article, no floor pick is one its owner would not publish, none
 * is unlabelled, and every `expect` held. Empty when it all does.
 */
export function firstLookShortfalls(report: FirstLookReport): string[] {
  const out: string[] = [];
  if (report.usable > 0 && report.planned < report.usable) {
    out.push(`First-look yield is ${report.planned}/${report.usable}: ${report.nothing.map((n) => `${n.caseId} (${n.ending})`).join(", ")} planned no article.`);
  }
  if (report.floor.no > 0) out.push(`${report.floor.no} pick${report.floor.no === 1 ? "" : "s"} made below the bar ${report.floor.no === 1 ? "is" : "are"} labelled as not worth publishing: ${report.floor.rejected.map((r) => `${r.caseId} "${r.term}"`).join(", ")}.`);
  if (report.floor.unlabelled > 0) out.push(`${report.floor.unlabelled} pick${report.floor.unlabelled === 1 ? "" : "s"} made below the bar ${report.floor.unlabelled === 1 ? "has" : "have"} no "would the owner publish this" label: ${report.floor.missing.map((r) => `${r.caseId} "${r.term}"`).join(", ")}.`);
  for (const u of report.unexpected) out.push(`${u.caseId}: expected ${u.expected}, got ${u.got}.`);
  return out;
}

/** The runs as scored items: a usable profile should end `planned`, a link that is not a site `refused`. */
export function firstLookItems(cases: readonly FirstLookCase[], runs: readonly FirstLookRun[]): Scored[] {
  return runs.map((r) => {
    const c = cases.find((x) => x.id === r.caseId);
    const expected = c?.expect?.refused ? "refused" : r.usableProfile ? "planned" : "needs_business";
    return {
      decision: "first-look-yield" as const,
      caseId: r.caseId,
      item: r.term ?? "(no topic)",
      expected,
      predicted: r.ending,
      agrees: expected === r.ending,
      reason: r.ending === "planned" ? `Planned on the ${r.rung} rung${r.lower ? ", lower confidence" : ""}.` : r.reason ?? null,
      note: c?.note ?? null,
    };
  });
}

export async function runFirstLook(dir: string, caseIds?: readonly string[]): Promise<{ cases: FirstLookCase[]; report: FirstLookReport; items: Scored[] }> {
  const cases = loadFirstLookCases(dir).filter((c) => !caseIds?.length || caseIds.includes(c.id));
  const runs: FirstLookRun[] = [];
  for (const c of cases) runs.push(await runFirstLookCase(c));
  return { cases, report: firstLookReport(cases, runs, loadFloorLabels(dir)), items: firstLookItems(cases, runs) };
}
