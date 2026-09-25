import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The recommender's two signals - Search Console impressions per query (the
 * "proven demand" boost) and the latest rank per keyword - are read in full.
 * Capped at PostgREST's max_rows they were an arbitrary first thousand: seeded
 * with 1,100 query rows, 1,000 came back (round-5 review).
 */

const { ensure } = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("@/lib/keyword-research/business-context", () => ({ ensureBusinessProfile: (...a: unknown[]) => ensure(...a) }));

import { recommendKeywords } from "../recommendations";

const MAX_ROWS = 1000;
const served: Record<string, number> = {};
const ranges: Record<string, Array<[number, number]>> = {};

function rowsFor(table: string): unknown[] {
  if (table === "keywords") return [{ id: "k1", term: "salon booking software", status: "new", volume: 480, difficulty: 8, intent: "commercial", opportunity: null, buyer_fit: null, plan_excluded_at: null }];
  if (table === "analytics_metrics") return Array.from({ length: 1100 }, (_, i) => ({ query: `query ${i}`, impressions: 1 }));
  if (table === "keyword_rankings") return Array.from({ length: 1100 }, (_, i) => ({ keyword_id: "k1", position: 12, checked_at: new Date(Date.now() - i * 60_000).toISOString() }));
  return [];
}

function client(): SupabaseClient {
  return {
    from(table: string) {
      let range: [number, number] | null = null;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "gte", "not", "is", "limit"]) q[m] = () => q;
      q.range = (from: number, to: number) => {
        range = [from, to];
        (ranges[table] ??= []).push([from, to]);
        return q;
      };
      q.single = async () => ({ data: { topical_profile: null, dr: 20, business_profile: null, domain: "acme-agency.example", language: "en", location_code: 2840, auto_generate_weekly_limit: 3 } });
      q.maybeSingle = async () => ({ data: null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => {
        const all = rowsFor(table);
        // PostgREST's cap: never more than MAX_ROWS in one response.
        const page = range ? all.slice(range[0], Math.min(range[1] + 1, range[0] + MAX_ROWS)) : all.slice(0, MAX_ROWS);
        served[table] = (served[table] ?? 0) + page.length;
        return resolve({ data: page, error: null });
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  for (const k of Object.keys(served)) delete served[k];
  for (const k of Object.keys(ranges)) delete ranges[k];
  ensure.mockReset().mockResolvedValue({ business: null, inferred: false, missing: null });
});

describe("recommendKeywords reads its signals in full", () => {
  it("pages through more than a thousand Search Console rows and rank checks", async () => {
    await recommendKeywords(client(), "ws", { limit: 10 });
    expect(served.analytics_metrics).toBe(1100);
    expect(served.keyword_rankings).toBe(1100);
    expect(ranges.analytics_metrics).toEqual([[0, 999], [1000, 1999]]);
    expect(ranges.keyword_rankings).toEqual([[0, 999], [1000, 1999]]);
  });
});
