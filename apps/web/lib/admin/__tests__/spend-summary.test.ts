import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSpendSummary, readSpendSummary, summarizeSpendRows, sumBy, type SpendRow } from "../spend-summary";
import { measuredRates, measuredRatesFromGroups } from "@/lib/billing/forecast";

// The Operations page summed the newest 2,000 provider_spend rows, and
// PostgREST answers at most 1,000: every total covered the newest thousand
// calls. These pin the whole-table sums, in the database or paged through.

const since = new Date("2026-09-16T00:00:00Z");
const row = (over: Partial<SpendRow> = {}): SpendRow => ({
  provider: "dataforseo",
  operation: "/serp/google/organic/task_get/regular/{id}",
  workspace_id: "ws-1",
  article_id: null,
  cost_usd: 0.001,
  created_at: "2026-10-10T00:00:00Z",
  ...over,
});

describe("summarizeSpendRows", () => {
  it("sums calls and price per group, splits recent from older, and counts a priceless call as a call", () => {
    const s = summarizeSpendRows(
      [row(), row(), row({ created_at: "2026-08-01T00:00:00Z" }), row({ cost_usd: null })],
      since,
    );
    expect(s.calls).toBe(4);
    expect(s.firstAt).toBe("2026-08-01T00:00:00Z");
    const recent = s.groups.find((g) => g.recent)!;
    expect(recent).toMatchObject({ calls: 3, priced: 2 });
    expect(recent.usd).toBeCloseTo(0.002, 9);
    expect(s.groups.find((g) => !g.recent)).toMatchObject({ calls: 1, priced: 1 });
  });

  it("counts distinct articles that priced model calls were bought for", () => {
    const s = summarizeSpendRows(
      [
        row({ provider: "anthropic", operation: "claude-sonnet-5", article_id: "a", cost_usd: 0.1 }),
        row({ provider: "anthropic", operation: "claude-sonnet-5", article_id: "a", cost_usd: 0.1 }),
        row({ provider: "anthropic", operation: "claude-sonnet-5", article_id: "b", cost_usd: null }),
      ],
      since,
    );
    expect(s.modelArticles).toBe(1);
  });
});

describe("measuredRatesFromGroups", () => {
  it("measures the same rate card as the row-by-row reading", () => {
    const rows: SpendRow[] = [
      ...[1, 2, 3].map(() => row({ cost_usd: 0.0009 })),
      ...["a", "a", "b", "c"].map((id) => row({ provider: "anthropic", operation: "claude-sonnet-5", article_id: id, cost_usd: 0.1 })),
      row({ provider: "anthropic", operation: "claude-sonnet-5", article_id: "d", cost_usd: null }),
    ];
    const s = summarizeSpendRows(rows, since);
    const fromRows = measuredRates(rows.map((r) => ({ provider: r.provider, operation: r.operation, costUsd: r.cost_usd === null ? null : Number(r.cost_usd), articleId: r.article_id })));
    expect(measuredRatesFromGroups(s.groups, s.modelArticles)).toEqual(fromRows);
  });
});

describe("readSpendSummary", () => {
  it("takes the database's sums when migration 116 is there", async () => {
    const rpc = vi.fn(async () => ({
      data: { calls: 1500, first_at: "2026-01-01T00:00:00Z", model_articles: 4, groups: [{ provider: "dataforseo", operation: "/x", workspace_id: "ws-1", stage: null, has_article: false, recent: true, calls: 1500, priced: 1500, usd: "1.5" }] },
      error: null,
    }));
    const s = await readSpendSummary({ rpc } as unknown as SupabaseClient, since);
    expect(rpc).toHaveBeenCalledWith("provider_spend_summary", { p_since: since.toISOString() });
    expect(s).toMatchObject({ calls: 1500, modelArticles: 4 });
    expect(s.groups[0].usd).toBe(1.5);
  });

  it("pages through every row without it: 1,500 rows are 1,500, not the first thousand", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ ...row(), id: String(i) }));
    const ranges: Array<[number, number]> = [];
    const db = {
      rpc: async () => ({ data: null, error: { message: "Could not find the function public.provider_spend_summary" } }),
      from: () => ({
        select: (_cols: string, opts: { count?: string }) => ({
          order: () => ({
            range: async (from: number, to: number) => {
              ranges.push([from, to]);
              // The server's cap: at most 1,000 rows a page.
              const page = rows.slice(from, Math.min(to + 1, from + 1000));
              return { data: page, error: null, count: opts.count ? rows.length : null };
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const s = await readSpendSummary(db, since);
    expect(s.calls).toBe(1500);
    expect(sumBy(s.groups, (g) => g.workspaceId).get("ws-1")?.usd).toBeCloseTo(1.5, 9);
    expect(ranges.length).toBeGreaterThan(1);
  });
});

describe("parseSpendSummary", () => {
  it("reads an empty table", () => {
    expect(parseSpendSummary({ calls: 0, first_at: null, model_articles: 0, groups: [] })).toEqual({ calls: 0, firstAt: null, modelArticles: 0, groups: [] });
  });
});
