// ---------------------------------------------------------------------------
// The next articles a trial would write, by name
// ---------------------------------------------------------------------------
//
// The gate's offer names them instead of listing generic benefits (Codex
// review, 2026-10-28). Only saved topics: what is on the calendar after the
// first article, then the qualified topics held for the trial
// (lib/onboarding/plan.ts `heldTopics`). Nothing is made up to fill the
// three: fewer topics, fewer lines.
//
// Client-safe and pure.

import { NEXT_ARTICLES_SHOWN } from "@/lib/billing/trial-offer";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Up to `max` topic names, scheduled first and in date order, then held,
 * without the first article's own search and without a search twice.
 */
export function nextArticles(
  planned: Array<{ term: string; date: string }>,
  held: string[] | null | undefined,
  firstKeyword: string | null | undefined,
  max = NEXT_ARTICLES_SHOWN,
): string[] {
  const out: string[] = [];
  const scheduled = [...planned].sort((a, b) => a.date.localeCompare(b.date)).map((p) => p.term);
  for (const term of [...scheduled, ...(held ?? [])]) {
    const name = term.trim();
    if (!name || (firstKeyword && same(name, firstKeyword)) || out.some((t) => same(t, name))) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
