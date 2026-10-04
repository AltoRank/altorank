import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArticleResearch } from "@/lib/seo/research";
import type { SiteFacts } from "@/lib/ai/types";

// A first draft whose writer claim the run's budget refused bought no
// article. The row the run created for it is empty, and is removed rather
// than left in the review queue as a broken draft; the caller reports the
// draft skipped (lib/onboarding/pipeline.ts, app/api/internal/draft). Every
// paid call is mocked; the site is invented.

vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => ({ limit: null, used: 0, remaining: null, reason: "plan", plan: "agency" }),
}));
vi.mock("@/lib/billing/spend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/spend")>()),
  recordSpend: async () => undefined,
}));
vi.mock("@/lib/billing/default-spend", () => ({ spendClient: () => null }));

const RESEARCH: ArticleResearch = {
  keyword: "acme booking cost",
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [],
  peopleAlsoAsk: [],
  aiOverview: null,
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1200,
  wordCountBasis: "test",
  layers: [],
  sourceFigures: [],
};
vi.mock("@/lib/seo/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/research")>()),
  gatherArticleResearch: async () => structuredClone(RESEARCH),
}));
vi.mock("@/lib/ai/article-questions", () => ({
  selectArticleQuestions: async (q: string[]) => ({ status: "qualified", kept: q, decisions: [] }),
}));
vi.mock("@/lib/content/site-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/site-facts")>()),
  loadSiteFacts: async () => ({
    facts: { pagesRead: 0, offerings: [], work: [], headings: [], stated: [], about: null, people: [], pages: [], conversion: null, notes: [] } as unknown as SiteFacts,
    layer: { id: "site_facts", status: "ok", detail: "test" },
  }),
}));
vi.mock("@/lib/seo/link-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/link-resolver")>()),
  fetchLinkTargets: async () => [],
}));
vi.mock("@/lib/linking/targets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/linking/targets")>()),
  fetchKnownPages: async () => [],
}));

const { writerClaims } = vi.hoisted(() => ({ writerClaims: { count: 0 } }));
vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: () => ({
    async *streamArticle() {
      writerClaims.count++;
      // What ClaudeProvider does when the budget will not cover its floor.
      const { BudgetRefusedError } = await import("@/lib/billing/spend-scope");
      throw new BudgetRefusedError("claude-sonnet-5", "draft", 0.42);
    },
  }),
}));

import { generateArticle } from "../generate";
import { isBudgetRefusal } from "@/lib/billing/spend-scope";

const updates: Array<{ table: string; row: Record<string, unknown> }> = [];
const deletes: string[] = [];

function client(opts: { deleteMatches: boolean }) {
  const workspace = {
    id: "ws1", account_id: "acc1", domain: "acme-booking.example", ai_provider: null, ai_model: null, language: "en", brand_style: null,
    location_code: null, status: "active", paused_until: null, business_profile: null,
  };
  return {
    from: (table: string) => {
      if (table === "articles" || table === "generation_jobs") {
        const id = table === "articles" ? "a1" : "job1";
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id }, error: null }) }) }),
          update: (row: Record<string, unknown>) => {
            updates.push({ table, row });
            return { eq: async () => ({ error: null }) };
          },
          delete: () => ({
            eq: (_c: string, v: string) => ({
              select: async () => {
                deletes.push(v);
                // RLS that filters the row out answers no error and no rows.
                return { data: opts.deleteMatches ? [{ id: v }] : [], error: null };
              },
            }),
          }),
        };
      }
      const chain: Record<string, unknown> = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => ({ data: table === "workspaces" ? workspace : null, error: null }),
        maybeSingle: async () => ({ data: table === "workspaces" ? workspace : null, error: null }),
      };
      return { select: () => chain, upsert: async () => ({ error: null }) };
    },
  } as never;
}

beforeEach(() => {
  updates.length = 0;
  deletes.length = 0;
  writerClaims.count = 0;
});

describe("a first draft the budget refused", () => {
  it("removes the empty row it created, rethrows the refusal, and marks the job failed", async () => {
    const err = await generateArticle({ supabase: client({ deleteMatches: true }), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null }).catch((e) => e);
    expect(isBudgetRefusal(err)).toBe(true);
    expect(writerClaims.count).toBe(1);
    expect(deletes).toEqual(["a1"]);
    expect(updates.filter((u) => u.table === "articles" && u.row.status === "error")).toEqual([]);
    expect(updates.find((u) => u.table === "generation_jobs")?.row).toMatchObject({ status: "failed" });
  });

  it("marks the row errored when it could not be removed", async () => {
    const err = await generateArticle({ supabase: client({ deleteMatches: false }), workspaceId: "ws1", keyword: "acme booking cost", callerEmail: null }).catch((e) => e);
    expect(isBudgetRefusal(err)).toBe(true);
    expect(deletes).toEqual(["a1"]);
    expect(updates.find((u) => u.table === "articles" && u.row.status === "error")).toBeDefined();
  });
});
