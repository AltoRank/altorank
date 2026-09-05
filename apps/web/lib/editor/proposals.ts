// ---------------------------------------------------------------------------
// The editor's proposal model, kept pure so it can be tested without a DOM
// ---------------------------------------------------------------------------
//
// Every AI result in the editor is a proposal: it sits beside the current
// value until someone accepts it, and accepting it only stages it. The Save
// button is the single write. These helpers are the arithmetic of that.

import { FIELD_LIMITS } from "@/lib/ai/micro";
import { applyDecisions, diffBlocks, summarizeDecisions } from "@/lib/refresh/hunks";
import type { Hunk, HunkDecision } from "@/lib/refresh/types";

export type { Hunk, HunkDecision };

export interface FieldCounter {
  count: number;
  limit: number;
  /** Past the limit: the result page truncates it. */
  over: boolean;
}

/**
 * `N/60` for a title, `N/160` for a meta description. A count, shown as one;
 * the limit is what a result page displays, not a score.
 */
export function fieldCounter(text: string | null | undefined, field: keyof typeof FIELD_LIMITS): FieldCounter {
  const count = (text ?? "").trim().length;
  const limit = FIELD_LIMITS[field];
  return { count, limit, over: count > limit };
}

/**
 * What is staged and not yet saved. `body` counts accepted rewrites and
 * applied edit sessions, not keystrokes: one "Apply to article" is one change
 * however many words it touched.
 */
export interface PendingChanges {
  title: boolean;
  meta: boolean;
  featuredImage: boolean;
  body: number;
}

export const NO_CHANGES: PendingChanges = { title: false, meta: false, featuredImage: false, body: 0 };

export function pendingCount(p: PendingChanges): number {
  return (p.title ? 1 : 0) + (p.meta ? 1 : 0) + (p.featuredImage ? 1 : 0) + p.body;
}

/** The header's line. */
export function pendingLabel(p: PendingChanges): string {
  const n = pendingCount(p);
  if (n === 0) return "No changes yet";
  return n === 1 ? "1 proposed change" : `${n} proposed changes`;
}

// ── Hunk-level review of a rewrite ──────────────────────────────────────────
//
// The refresh engine's block diff (`lib/refresh/hunks.ts`) is the one hunk
// model in the repo; the editor's rewrite proposal is reviewed with it rather
// than with a diff of its own. Two diff libraries would disagree about what a
// hunk is, and a reviewer who learned Keep/Reject in Improvements should meet
// the same blocks here.

/** The blocks a rewrite touched, paired with what they replace. */
export function proposeHunks(before: string, after: string): Hunk[] {
  return diffBlocks(before, after);
}

/** The hunks a person decides on; `unchanged` blocks are context. */
export function reviewableHunks(hunks: readonly Hunk[]): Hunk[] {
  return hunks.filter((h) => h.kind !== "unchanged");
}

/** Every reviewable hunk decided the same way: the panel opens on "N / N kept". */
export function decideAll(hunks: readonly Hunk[], decision: HunkDecision): Record<string, HunkDecision> {
  return Object.fromEntries(reviewableHunks(hunks).map((h) => [h.id, decision]));
}

/**
 * The article the kept hunks produce. A rejected or undecided hunk keeps the
 * original block, an added block appears only when kept, a removed block
 * disappears only when kept. Delegates to the refresh engine's
 * `applyDecisions`, so the editor and Improvements cannot drift apart on what
 * "kept" means.
 */
export function applyHunks(hunks: readonly Hunk[], decisions: Record<string, HunkDecision>): string {
  return applyDecisions(hunks, decisions);
}

/** "N / M kept" for the header line. */
export function keptSummary(hunks: readonly Hunk[], decisions: Record<string, HunkDecision>) {
  return summarizeDecisions(hunks, decisions);
}

/**
 * The paragraph an image sits in, or the one before it, for the image
 * generator's context. Pure so it can be tested: `html` is the document and
 * `src` the image to locate.
 */
export function surroundingParagraph(html: string, src: string): string {
  const idx = html.indexOf(src);
  if (idx < 0) return "";
  const before = html.slice(0, idx);
  const after = html.slice(idx);
  // The nearest paragraph after the image, else the nearest before it.
  const next = after.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const prevAll = [...before.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  const prev = prevAll.length ? prevAll[prevAll.length - 1][1] : undefined;
  const pick = next ?? prev ?? "";
  return pick.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Plain text of the article's H2s, for the micro-rewrite context. */
export function outlineOf(html: string): string[] {
  return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
}
