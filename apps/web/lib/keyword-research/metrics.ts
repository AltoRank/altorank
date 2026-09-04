// ---------------------------------------------------------------------------
// Volume, difficulty, CPC and intent for a list of exact terms
// ---------------------------------------------------------------------------
//
// One DataForSEO Labs keyword_overview call answers up to 700 terms, so every
// tab in the research drawer that starts from phrases - audiences, playbooks,
// Find, Import - pays for one round trip rather than one per term.
//
// Verified live on 2026-09-04 (status 20000, $0.012 for three terms): a term
// the index does not know is simply ABSENT from `items`, not returned with
// nulls. "No search data" therefore means "not in the response", and the
// parser below returns a map so the caller can tell absence from zero.

import { post } from "@/lib/seo/client";
import { classifyIntent } from "@/lib/seo/intent";
import type { KeywordIntent } from "@/lib/types";

export interface TermMetrics {
  term: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: KeywordIntent;
}

/** Every field optional: this is an external payload we do not control. */
export type OverviewItem = {
  keyword?: string | null;
  keyword_info?: {
    search_volume?: number | null;
    cpc?: number | null;
    competition?: number | null;
  } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};

type OverviewResult = { items?: OverviewItem[] | null; items_count?: number | null };

/** Labs accepts up to 700 keywords per task. */
const BATCH = 700;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function mapIntent(raw: string | null | undefined, term: string, languageCode: string): KeywordIntent {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("commercial")) return "commercial";
  if (lower.includes("transactional")) return "transactional";
  if (lower.includes("navigational")) return "navigational";
  if (lower.includes("informational")) return "info";
  return classifyIntent(term, languageCode).intent;
}

/**
 * Map one overview row, or null when it carries no usable keyword.
 *
 * Difficulty 0 on a term with real volume is the provider saying "not
 * computed", not "free": "notion alternatives" came back at 1,600/mo with
 * keyword_difficulty 0 on the very first live call. `recommendations.ts`
 * already refuses to score that as easy; the Easy-win badge would otherwise
 * light up on exactly the terms we know least about, so it becomes unknown.
 */
export function parseOverviewItem(item: OverviewItem, languageCode = "en"): TermMetrics | null {
  const term = (item.keyword ?? "").trim();
  if (!term) return null;
  const volume = num(item.keyword_info?.search_volume);
  let difficulty = num(item.keyword_properties?.keyword_difficulty);
  if (difficulty === 0 && (volume ?? 0) >= 1000) difficulty = null;
  return {
    term,
    volume,
    difficulty,
    cpc: num(item.keyword_info?.cpc),
    intent: mapIntent(item.search_intent_info?.main_intent, term, languageCode),
  };
}

/**
 * Metrics for `terms`, keyed by lower-cased term. A term missing from the map
 * was not in the index; the caller reports it as "no search data".
 */
export async function fetchTermMetrics(
  terms: string[],
  options?: { languageCode?: string; locationCode?: number },
): Promise<Map<string, TermMetrics>> {
  const languageCode = options?.languageCode ?? "en";
  const locationCode = options?.locationCode ?? 2840;
  const out = new Map<string, TermMetrics>();

  const clean = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return out;

  for (let i = 0; i < clean.length; i += BATCH) {
    const response = await post<OverviewResult>("/dataforseo_labs/google/keyword_overview/live", [
      { keywords: clean.slice(i, i + BATCH), location_code: locationCode, language_code: languageCode },
    ]);
    if (process.env.NODE_ENV !== "production") {
      console.info(`[keyword-research] keyword_overview x${Math.min(BATCH, clean.length - i)} terms cost $${response.cost ?? "?"}`);
    }
    for (const task of response.tasks ?? []) {
      for (const result of task.result ?? []) {
        const items = Array.isArray(result?.items) ? result.items : [result as unknown as OverviewItem];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const parsed = parseOverviewItem(item, languageCode);
          if (parsed) out.set(parsed.term.toLowerCase(), parsed);
        }
      }
    }
  }
  return out;
}
