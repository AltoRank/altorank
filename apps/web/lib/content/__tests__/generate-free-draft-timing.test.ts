import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A free draft is spent when a draft exists, not when its row does.
 *
 * `free_drafts_used` was written right after the `articles` insert, before a
 * word was generated. On 2026-09-09 Vercel killed a run at the function limit
 * mid-generation; the sweeper marked the zero-word row `error`, and the next
 * run told qasimcode.com "All 7 free drafts are used" with five real drafts on
 * the account. The counter had charged the customer for the platform's own
 * timeout.
 *
 * This stops the run at the job insert - before any model call - the same way
 * the burst test does, and asserts the counter was never touched.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...args: unknown[]) => getQuota(...args),
  quotaExceededMessage: () => "out of quota",
}));

import { generateArticle } from "../generate";

const accountUpdates: Record<string, unknown>[] = [];

function client() {
  const single = async () => ({
    data: {
      id: "ws1", account_id: "agency1", domain: "example.test", ai_provider: null, ai_model: null,
      language: null, brand_style: null, location_code: null, status: "active", paused_until: null,
    },
    error: null,
  });
  const empty = async () => ({ data: null, error: null });
  return {
    from: (table: string) => {
      if (table === "articles") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "a1" }, error: null }) }) }),
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === "generation_jobs") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "killed before the model" } }) }) }),
        };
      }
      if (table === "accounts") {
        return {
          update: (patch: Record<string, unknown>) => {
            accountUpdates.push(patch);
            return { eq: async () => ({ error: null }) };
          },
          select: () => ({ eq: () => ({ single, maybeSingle: empty }) }),
        };
      }
      const chain: Record<string, unknown> = { eq: () => chain, ilike: () => chain, limit: () => chain, single, maybeSingle: empty };
      return { select: () => chain };
    },
  } as never;
}

beforeEach(() => {
  accountUpdates.length = 0;
  getQuota.mockReset().mockResolvedValue({ limit: 7, used: 5, remaining: 2, reason: "no-plan", plan: null });
});

describe("generateArticle on the free tier, killed before the model", () => {
  it("does not spend a free draft on a row at zero words", async () => {
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "salon booking website", autonomous: true, callerEmail: null }),
    ).rejects.toThrow();
    expect(accountUpdates.some((p) => "free_drafts_used" in p)).toBe(false);
  });
});
