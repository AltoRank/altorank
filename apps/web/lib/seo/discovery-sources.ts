import { post } from "./client";
import { parseKeywordIdea, type DiscoveredKeyword } from "./keywords";
import type { OverviewItem } from "@/lib/keyword-research/metrics";
import type { KeywordLineage } from "@/lib/keyword-research/evidence";

type Locale = { languageCode: string; locationCode: number };
export async function expandCategory(seeds: string[], locale: Locale): Promise<DiscoveredKeyword[]> {
  if (!seeds.length) return [];
  return expand("ideas", { keywords: seeds.slice(0, 3), limit: 40, filters: [["keyword_info.search_volume", ">=", 10]] }, locale, seeds[0]);
}
export async function expandRelated(seed: string, locale: Locale): Promise<DiscoveredKeyword[]> {
  return expand("related", { keyword: seed, depth: 2, limit: 20, filters: [["keyword_data.keyword_info.search_volume", ">=", 10]] }, locale, seed);
}
async function expand(source: "ideas" | "related", task: Record<string, unknown>, locale: Locale, seed: string): Promise<DiscoveredKeyword[]> {
  const endpoint = source === "ideas" ? "keyword_ideas" : "related_keywords";
  const response = await post<{ items?: (OverviewItem & { keyword_data?: OverviewItem })[] }>(`/dataforseo_labs/google/${endpoint}/live`, [{ ...task, language_code: locale.languageCode, location_code: locale.locationCode }]);
  const out: DiscoveredKeyword[] = [];
  for (const t of response.tasks ?? []) for (const r of t.result ?? []) for (const item of r.items ?? []) {
    const raw = item.keyword_data ?? item;
    const parsed = parseKeywordIdea(raw, locale.languageCode);
    if (parsed) out.push({ ...parsed, evidence: { sources: [{ source, seed }], ...locale, fetchedAt: new Date().toISOString(), metrics: { measuredAt: raw.keyword_info?.last_updated_time ?? null, mainIntent: raw.search_intent_info?.main_intent ?? null, secondaryIntents: raw.search_intent_info?.secondary_intents ?? [] } } });
  }
  return out;
}

export interface CompetitorEvidence { domain: string; source: "domain-overlap" | "category-serp"; keywords: string[]; }
export async function discoverRankingDomains(domain: string, seeds: string[], locale: Locale, hasRankings: boolean): Promise<CompetitorEvidence[]> {
  const source = hasRankings ? "domain-overlap" : "category-serp";
  if (!hasRankings && !seeds.length) return [];
  const endpoint = hasRankings ? "competitors_domain" : "serp_competitors";
  const response = await post<{ items?: { domain?: string }[] }>(`/dataforseo_labs/google/${endpoint}/live`, [{
    ...(hasRankings ? { target: domain, exclude_top_domains: true } : { keywords: seeds.slice(0, 3), item_types: ["organic"] }),
    language_code: locale.languageCode, location_code: locale.locationCode, limit: 6,
  }]);
  const seen = new Set<string>();
  return (response.tasks ?? []).flatMap((t) => (t.result ?? []).flatMap((r) => r.items ?? [])).flatMap((row) => {
    let host: string;
    try { host = new URL(`https://${row.domain}`).hostname.replace(/^www\./, ""); } catch { return []; }
    if (!row.domain || host === domain || seen.has(host)) return [];
    seen.add(host);
    return [{ domain: host, source, keywords: seeds.slice(0, 3) }];
  });
}
export function sourceLineage(source: KeywordLineage["source"], locale: Locale, rest: Omit<KeywordLineage, "source"> = {}) {
  return { sources: [{ source, ...rest }], ...locale, fetchedAt: new Date().toISOString() };
}
