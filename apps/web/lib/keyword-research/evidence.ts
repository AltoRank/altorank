import type { MetricMetadata } from "./metrics";
export const SEED_FAMILIES = ["category", "buying-decision", "alternatives", "migration", "problem"] as const;
export type SeedFamily = typeof SEED_FAMILIES[number];
export type KeywordLineage = {
  source: "overview" | "suggestions" | "ideas" | "related" | "competitor" | "ranking";
  seed?: string;
  family?: SeedFamily;
  domain?: string;
};
export type KeywordEvidence = {
  sources: KeywordLineage[];
  languageCode: string;
  locationCode: number;
  fetchedAt: string;
  metrics?: MetricMetadata;
};

/** Reserve a turn for each source/buying job before filling globally. */
export function coverageOrder<T>(items: T[], group: (item: T) => string, limit = items.length): T[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) { const key = group(item); const bucket = buckets.get(key) ?? []; bucket.push(item); buckets.set(key, bucket); }
  const result: T[] = [];
  while (result.length < limit && buckets.size) {
    for (const [key, rows] of buckets) {
      result.push(rows.shift()!);
      if (!rows.length) buckets.delete(key);
      if (result.length === limit) break;
    }
  }
  return result;
}
