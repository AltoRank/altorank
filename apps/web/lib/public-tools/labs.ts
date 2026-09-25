// ---------------------------------------------------------------------------
// DataForSEO Labs keyword rows, as the data tools read them
// ---------------------------------------------------------------------------
//
// Only the fields the tools show. Every number can be missing: a keyword the
// provider has not measured comes back null, and it stays null here, shown as
// a dash, never as 0.

export interface LabsKeywordData {
  keyword: string;
  keyword_info?: {
    search_volume?: number | null;
    cpc?: number | null;
    competition_level?: string | null;
    search_volume_trend?: { yearly?: number | null } | null;
  } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
}

/** keyword_suggestions / keyword_ideas: items are keyword data. */
export interface LabsSuggestionsResult {
  seed_keyword_data?: LabsKeywordData | null;
  total_count?: number | null;
  items?: LabsKeywordData[] | null;
}

/** related_keywords: items wrap keyword data with a depth. */
export interface LabsRelatedResult {
  seed_keyword_data?: LabsKeywordData | null;
  items?: Array<{ depth?: number; keyword_data: LabsKeywordData }> | null;
}

export interface KeywordRow {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function toRow(d: LabsKeywordData): KeywordRow {
  return {
    keyword: d.keyword,
    volume: num(d.keyword_info?.search_volume),
    difficulty: num(d.keyword_properties?.keyword_difficulty),
    cpc: num(d.keyword_info?.cpc),
    intent: d.search_intent_info?.main_intent ?? null,
  };
}

/** Rows deduplicated by keyword (case-insensitive), first one wins. */
export function dedupeRows(rows: KeywordRow[]): KeywordRow[] {
  const seen = new Map<string, KeywordRow>();
  for (const r of rows) {
    const k = r.keyword.trim().toLowerCase();
    if (k && !seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

export const byVolumeDesc = (a: KeywordRow, b: KeywordRow) => (b.volume ?? -1) - (a.volume ?? -1);

export const fmtInt = (n: number | null) => (n === null ? "—" : Math.round(n).toLocaleString("en-US"));
export const fmtUsd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
