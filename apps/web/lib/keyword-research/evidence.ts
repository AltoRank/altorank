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

/** Balance decision families first, then seeds within each family. A category
 * with many seed variants must not crowd out a migration or problem task. */
export function decisionCoverageOrder<T>(items:T[], lineage:(item:T)=>KeywordLineage|undefined, limit=items.length):T[] {
  const family=(item:T)=>lineage(item)?.family ?? lineage(item)?.source ?? "legacy";
  const families=new Map<string,T[]>();
  for(const item of items){const key=family(item);const rows=families.get(key)??[];rows.push(item);families.set(key,rows);}
  const interleaved=[...families.values()].flatMap(rows=>coverageOrder(rows,item=>lineage(item)?.seed??lineage(item)?.domain??""));
  return coverageOrder(interleaved,family,limit);
}
