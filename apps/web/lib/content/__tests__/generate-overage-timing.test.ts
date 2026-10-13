import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Past the included volume a person's Write now is billed the overage - once
 * the draft exists. The Stripe invoice item used to be created before the
 * row, the research and the model call, so a draft that then failed billed
 * the customer for no article (round-5 review). The run here stops at the
 * research, after its job row, and the invoice item must not exist.
 */

const getQuota = vi.fn();
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: (...args: unknown[]) => getQuota(...args),
}));
const recordOverageArticle = vi.fn(async () => undefined);
vi.mock("@/lib/billing/overage", () => ({ recordOverageArticle: (...a: unknown[]) => recordOverageArticle(...(a as [])) }));
vi.mock("@/lib/seo/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/research")>()),
  gatherArticleResearch: async () => {
    throw new Error("stop here: research failed");
  },
}));
vi.mock("@/lib/content/site-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/site-facts")>()),
  loadSiteFacts: async () => null,
}));

import { generateArticle } from "../generate";
import { pastIncludedVolume } from "@/lib/billing/quota";

let jobs = 0;
/** The article row the fake returns to a select on `articles`; null = none. */
let target: { status: string; created_at: string; content: unknown } | null = null;

function client() {
  const workspace = {
    id: "ws1", account_id: "acc1", domain: "acme-agency.example", ai_provider: null, ai_model: null,
    language: null, brand_style: null, location_code: null, status: "active", paused_until: null, business_profile: null,
  };
  return {
    from: (table: string) => {
      if (table === "articles") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "a1" }, error: null }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({ eq: async () => ({ error: null }) }),
          select: () => {
            const filters: string[] = [];
            const q: Record<string, unknown> = {
              eq: () => q,
              not: (col: string) => (filters.push(`not ${col}`), q),
              maybeSingle: async () => {
                if (!target) return { data: null, error: null };
                // articleHasText asks for rows whose content is not null.
                if (filters.includes("not content") && target.content === null) return { data: null, error: null };
                return { data: { id: "a1", ...target }, error: null };
              },
              single: async () => (target ? { data: { id: "a1", ...target }, error: null } : { data: null, error: { message: "none" } }),
            };
            return q;
          },
        };
      }
      if (table === "generation_jobs") {
        return {
          insert: () => ({ select: () => ({ single: async () => ((jobs += 1), { data: { id: "job1" }, error: null }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      const chain: Record<string, unknown> = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => chain,
        single: async () => ({ data: workspace, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return { select: () => chain };
    },
  } as never;
}

beforeEach(() => {
  jobs = 0;
  target = null;
  recordOverageArticle.mockClear();
  getQuota.mockReset().mockResolvedValue({ limit: 100, used: 100, remaining: 0, reason: "plan", plan: "starter" });
});

describe("the overage on a draft past the included volume", () => {
  it("is not billed when the draft fails after its research was asked for", async () => {
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "salon booking website", callerEmail: null }),
    ).rejects.toThrow(/stop here/);
    expect(jobs).toBe(1);
    expect(recordOverageArticle).not.toHaveBeenCalled();
  });

  it("still refuses an autonomous draft at the limit, before anything", async () => {
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "salon booking website", autonomous: true, callerEmail: null }),
    ).rejects.toThrow();
    expect(jobs).toBe(0);
    expect(recordOverageArticle).not.toHaveBeenCalled();
  });
});

describe("a draft written into a row the quota already counts", () => {
  // The agent API inserts its own `drafting` row, then generates into it; getQuota
  // counts that row, so at the last included article `used` equals the limit.
  it("is the last included article at used = limit, not an overage", () => {
    expect(pastIncludedVolume({ limit: 100, used: 100, remaining: 0 }, { targetCounted: true })).toBe(false);
    expect(pastIncludedVolume({ limit: 100, used: 101, remaining: -1 }, { targetCounted: true })).toBe(true);
    expect(pastIncludedVolume({ limit: 100, used: 100, remaining: 0 }, { targetCounted: false })).toBe(true);
    expect(pastIncludedVolume({ limit: null, used: 999, remaining: null }, { targetCounted: false })).toBe(false);
  });

  it("lets an autonomous draft into its own counted row past the quota test at used = limit", async () => {
    target = { status: "drafting", created_at: new Date().toISOString(), content: null };
    // Past the quota test it meets the next one, the tracked-topic check the
    // fake cannot satisfy; the quota's own refusal would have come first.
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "salon booking website", articleId: "a1", autonomous: true, callerEmail: null }),
    ).rejects.toThrow(/Automatic writing requires/);
    expect(recordOverageArticle).not.toHaveBeenCalled();
  });

  it("still counts a row from last month, or one with text, as one more", async () => {
    target = { status: "drafting", created_at: "2000-01-01T00:00:00Z", content: null };
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "salon booking website", articleId: "a1", autonomous: true, callerEmail: null }),
    ).rejects.toThrow(/Limit|limit|included|used/);
    target = { status: "review", created_at: new Date().toISOString(), content: { type: "doc" } };
    await expect(
      generateArticle({ supabase: client(), workspaceId: "ws1", keyword: "salon booking website", articleId: "a1", autonomous: true, callerEmail: null }),
    ).rejects.toThrow(/Limit|limit|included|used/);
    expect(jobs).toBe(0);
  });
});
