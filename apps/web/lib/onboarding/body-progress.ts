// ---------------------------------------------------------------------------
// The first article being written, as counts: which sections, how many words
// ---------------------------------------------------------------------------
//
// With PRETRIAL_FULL_ARTICLE off the gate shows the outline while the body
// is written behind it, and for two minutes nothing on the page moved
// (recorded 2026-10-12). The draft route now keeps a counts-only record on
// the article (`articles.body_progress`, migration 108) - the stage, when it
// began, how many H2s the writer has started, how many words - and the gate
// ticks the outline off from it. Nothing here carries a word of the text:
// `measureStream` reads the writer's html and returns two numbers.
//
// The writer is held to the outline (lib/content/outline.ts): it writes the
// outline's sections as its H2s, in order, word for word. So the n-th H2 it
// starts is the outline's n-th section, and a section is written once the
// next one has started. The closing heading is added by enrichment after the
// writer, so it, and the last section, are written only once the writer is.

import { BODY_ORDER, type BodyStage } from "./setup-progress";

export const BODY_PROGRESS_VERSION = 1;

/** What `articles.body_progress` holds. Counts and a time, no text. */
export interface BodyProgress {
  v: typeof BODY_PROGRESS_VERSION;
  stage: BodyStage;
  /** ISO time the stage began. */
  since: string;
  /** H2s the writer has started. */
  sections: number;
  /** Words of body text so far. */
  words: number;
}

/** The record, or null when `raw` is not one. */
export function readBodyProgress(raw: unknown): BodyProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BodyProgress>;
  if (r.v !== BODY_PROGRESS_VERSION || !BODY_ORDER.includes(r.stage as BodyStage) || typeof r.since !== "string") return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  return { v: BODY_PROGRESS_VERSION, stage: r.stage as BodyStage, since: r.since, sections: n(r.sections), words: n(r.words) };
}

/**
 * Two numbers off the writer's html so far: the H2s it has opened, and the
 * words of body text. The writer's own <h1> and meta description are not
 * the body and are not counted; a tag it is half-way through is not a word.
 */
export function measureStream(html: string): { sections: number; words: number } {
  const body = html
    .replace(/<h1\b[^>]*>[\s\S]*?(?:<\/h1>|$)/gi, " ")
    .replace(/<meta-description\b[^>]*>[\s\S]*?(?:<\/meta-description>|$)/gi, " ");
  const sections = (body.match(/<h2\b/gi) ?? []).length;
  const text = body.replace(/<[^>]*>?/g, " ").replace(/&[a-zA-Z#0-9]+;/g, " ");
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { sections, words };
}

/**
 * The outline's section indexes that are written, out of `total` (the
 * outline's headings, closing included). While the writer writes, every
 * section before the one it is in; once it has finished, every section but
 * the closing one, which enrichment adds; once the body is saved, all.
 */
export function sectionsDone(progress: Pick<BodyProgress, "stage" | "sections"> | null, total: number, opts: { done: boolean; hasClosing: boolean }): number[] {
  const all = Array.from({ length: Math.max(0, total) }, (_, i) => i);
  if (opts.done) return all;
  if (!progress) return [];
  if (progress.stage === "finishing") return opts.hasClosing ? all.slice(0, -1) : all;
  if (progress.stage !== "writing") return [];
  const writable = opts.hasClosing ? total - 1 : total;
  return all.slice(0, Math.max(0, Math.min(progress.sections - 1, writable)));
}
