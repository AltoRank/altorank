// ---------------------------------------------------------------------------
// From raw provider rows to an honest proposal
// ---------------------------------------------------------------------------
//
// Pure. Everything that decides what a person sees after a research run -
// which rows are dropped, why, in what order the rest appear, how many slots
// remain - is arithmetic over data already fetched, so the same inputs always
// give the same table and every count in the summary line can be tested.

import { normalizeTarget } from "@/lib/seo/recommendations";
import { SCHEDULE_CAP } from "@/lib/onboarding/plan";
import type { PlanCapacity, ResearchCandidate, ResearchFunnel } from "./types";

/** Below this the term is real but not worth an article slot. */
export const MIN_VOLUME = 50;

/** Search volume and difficulty at which a keyword is a plausible quick win. */
export const EASY_WIN_MIN_VOLUME = 100;
export const EASY_WIN_MAX_DIFFICULTY = 30;

export { SCHEDULE_CAP };

export function isEasyWin(c: Pick<ResearchCandidate, "volume" | "difficulty">): boolean {
  return (
    typeof c.volume === "number" &&
    typeof c.difficulty === "number" &&
    c.volume >= EASY_WIN_MIN_VOLUME &&
    c.difficulty <= EASY_WIN_MAX_DIFFICULTY
  );
}

/** "N of 60 scheduled · M slots available" comes from here and nowhere else. */
export function planCapacity(scheduled: number, cap = SCHEDULE_CAP): PlanCapacity {
  const clamped = Math.max(0, Math.floor(scheduled));
  return { scheduled: clamped, cap, slots: Math.max(0, cap - clamped) };
}

export function capacityLine(c: PlanCapacity): string {
  return `${c.scheduled} of ${c.cap} scheduled · ${c.slots} slot${c.slots === 1 ? "" : "s"} available`;
}

/** A keyword row the workspace already holds, as much of it as dedupe needs. */
export interface ExistingKeyword {
  id: string;
  term: string;
  status: string;
}

/**
 * Decide, per candidate, whether it is already tracked.
 *
 * Matches on `normalizeTarget`, the same collapse the recommendation queue
 * uses, so "seo for agencies" is recognised as the tracked "agency seo" and
 * the drawer does not propose a keyword the calendar already carries under a
 * different word order.
 */
export function markExisting(
  candidates: ResearchCandidate[],
  existing: ExistingKeyword[],
): ResearchCandidate[] {
  const byTarget = new Map<string, ExistingKeyword>();
  for (const k of existing) {
    const key = normalizeTarget(k.term);
    if (key && !byTarget.has(key)) byTarget.set(key, k);
  }
  return candidates.map((c) => {
    const hit = byTarget.get(normalizeTarget(c.term));
    return hit ? { ...c, existingId: hit.id, existingStatus: hit.status } : { ...c, existingId: null, existingStatus: null };
  });
}

/**
 * One row per query. Two provider rows that collapse to the same target keep
 * the one with the higher volume; on a tie, the shorter phrasing.
 */
export function dedupeCandidates(candidates: ResearchCandidate[]): ResearchCandidate[] {
  const best = new Map<string, ResearchCandidate>();
  for (const c of candidates) {
    const key = normalizeTarget(c.term);
    if (!key) continue;
    const prev = best.get(key);
    if (
      !prev ||
      (c.volume ?? -1) > (prev.volume ?? -1) ||
      ((c.volume ?? -1) === (prev.volume ?? -1) && c.term.length < prev.term.length)
    ) {
      best.set(key, c);
    }
  }
  return [...best.values()];
}

/**
 * Easy wins first, then by volume. Unknown volume sorts last: we cannot rank
 * what we could not measure, and pretending it is 0 would bury it under
 * everything measured, which is the same thing said less honestly.
 */
export function rankCandidates(candidates: ResearchCandidate[]): ResearchCandidate[] {
  return [...candidates].sort((a, b) => {
    const ea = isEasyWin(a) ? 1 : 0;
    const eb = isEasyWin(b) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const va = a.volume ?? -1;
    const vb = b.volume ?? -1;
    if (va !== vb) return vb - va;
    return a.term.localeCompare(b.term);
  });
}

export interface FunnelOptions {
  /** How many to propose. Everything past it is still counted as found. */
  limit?: number;
  minVolume?: number;
  /**
   * Keep rows whose term is already tracked. Off for Generate and Playbooks,
   * where proposing a keyword already on the calendar is noise; on for Find
   * and Import, where the person typed the term and deserves to see it, with
   * its status, rather than watch it vanish.
   */
  keepExisting?: boolean;
  /**
   * Keep rows with no search data. The Find and Import tabs show them with a
   * dash because the person asked about that exact term; Generate drops them
   * because nobody asked about them and there is nothing to say.
   */
  keepNoData?: boolean;
}

/**
 * Apply the funnel and account for every row that leaves it.
 *
 * `found` is the number of distinct queries the providers returned. Every
 * other number is a subset of it, and `proposed` is what is left. The summary
 * line is built from these and only these, so it can never claim a keyword
 * the table does not show.
 */
export function applyFunnel(
  raw: ResearchCandidate[],
  existing: ExistingKeyword[],
  opts: FunnelOptions = {},
): { candidates: ResearchCandidate[]; funnel: ResearchFunnel } {
  const minVolume = opts.minVolume ?? MIN_VOLUME;
  const deduped = markExisting(dedupeCandidates(raw), existing);
  const found = deduped.length;

  let skippedExisting = 0;
  let skippedNoData = 0;
  let skippedLowVolume = 0;
  const kept: ResearchCandidate[] = [];

  for (const c of deduped) {
    if (c.existingId && !opts.keepExisting) {
      skippedExisting++;
      continue;
    }
    if (c.volume === null) {
      if (opts.keepNoData) {
        kept.push(c);
      } else {
        skippedNoData++;
      }
      continue;
    }
    if (c.volume < minVolume) {
      skippedLowVolume++;
      continue;
    }
    kept.push(c);
  }

  const ranked = rankCandidates(kept);
  const candidates = typeof opts.limit === "number" ? ranked.slice(0, Math.max(0, opts.limit)) : ranked;

  return {
    candidates,
    funnel: { found, skippedNoData, skippedLowVolume, skippedExisting, proposed: candidates.length },
  };
}

/**
 * The sentence after a run. Only says what happened: a zero stage is left
 * out rather than reported as "0 skipped", and `scheduled` appears only once
 * something has been scheduled.
 */
export function funnelLine(f: ResearchFunnel, scheduled = 0): string {
  const parts = [`Found ${f.found}`];
  if (f.skippedExisting) parts.push(`${f.skippedExisting} already tracked`);
  if (f.skippedNoData) parts.push(`${f.skippedNoData} skipped, no search data`);
  if (f.skippedLowVolume) parts.push(`${f.skippedLowVolume} skipped, too little volume`);
  if (scheduled > 0) parts.push(`${scheduled} scheduled`);
  else parts.push(`${f.proposed} proposed`);
  return parts.join(" · ");
}

/**
 * Split pasted text into terms. Commas and newlines separate; blank entries
 * and duplicates go; case is preserved for display and folded for identity.
 */
export function parseTermList(text: string, max = 200): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}
