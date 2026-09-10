import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The cron honours the free allowance's rule: no second unattended draft
 * until a person has read the first. A paid plan is a volume limit and is
 * not gated.
 */
const { generateArticle, firstDraftAwaitsReview, getQuota } = vi.hoisted(() => ({
  generateArticle: vi.fn(), firstDraftAwaitsReview: vi.fn(), getQuota: vi.fn(),
}));
let workspaces: Record<string, unknown>[] = [];
function table(name: string) {
  const chain: Record<string, unknown> = {}; const self = () => chain;
  Object.assign(chain, {
    select: self, eq: self, neq: self, gte: self, order: self, is: self, not: self, lt: self, in: self, limit: self,
    single: async () => ({ data: { topical_profile: { terms: { a: 1, b: 1, c: 1, d: 1 } } }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (r: (v: unknown) => unknown) => r(name === "workspaces" ? { data: workspaces, error: null } : { data: [], error: null }),
  });
  return chain;
}
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: async () => [{ term: "salon booking website", keywordId: "kw-1", action: "write", quality: "ok", reasons: ["fixture"], score: 1, difficulty: 10, volume: 100 }],
  pickNextKeyword: (recs: { action: string; quality: string }[]) => recs.find((r) => r.action === "write" && r.quality === "ok") ?? null,
}));
vi.mock("@/lib/onboarding/plan", () => ({ duePlannedKeyword: async () => null, fulfilPlannedEntry: async () => {}, closeCoveredEntries: async () => 0 }));
vi.mock("@/lib/billing/quota", () => ({ getQuota: (...a: unknown[]) => getQuota(...a), quotaExceededMessage: () => "quota" }));
vi.mock("@/lib/billing/first-draft-gate", () => ({ firstDraftAwaitsReview: (...a: unknown[]) => firstDraftAwaitsReview(...a) }));
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: async () => ({ allowed: true, reason: "plan", quota: { limit: null, remaining: null }, message: null }) }));
vi.mock("@/lib/billing/resume", () => ({ resumeExpiredPauses: async () => [], isoDay: (d: Date) => d.toISOString().slice(0, 10) }));
vi.mock("@/lib/stripe", () => ({ billingEnabled: false, getStripe: () => null }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generateArticle(...a), ConcurrentGenerationError: class extends Error {} }));
vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ articlesLeft: 1 }), describePaceBudget: () => "" }));
vi.mock("@/lib/plan/frozen", () => ({ readFrozenEntries: async () => ({ ids: new Set(), reason: null }) }));
vi.mock("@/lib/email/agency-recipients", () => ({ agencyRecipients: async () => ["o@x.test"], agencyBillingRecipients: async () => [], userEmail: async () => null }));
vi.mock("@/lib/email/article-emails", () => ({ sendArticleDraftedEmails: async () => ({ sent: 1, skipped: 0, failed: 0 }) }));
vi.mock("@/lib/email/schedule-events", () => ({ announceNothingWritten: async () => "", announcePausedSites: async () => [], announceSetupUnfinished: async () => "", nothingWrittenReason: () => null, remindEndingPauses: async () => [], sweepUnfinishedSetups: async () => [] }));

import { GET } from "../generate/route";
const req = () => new Request("http://localhost/api/cron/generate", { headers: { "x-cron-secret": "s" } });

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  workspaces = [{ id: "ws-1", domain: "qasimcode.com", agency_id: "ag-1", auto_generate_weekly_limit: 7, refresh_enabled: false, refresh_days: null, onboarded_at: "2026-09-07T10:00:00Z", onboarding_skipped_at: null }];
  generateArticle.mockReset().mockResolvedValue({ articleId: "art-2", title: "T", wordCount: 400, factCheck: { verdict: "clean" } });
  firstDraftAwaitsReview.mockReset().mockResolvedValue(null);
});

describe("cron/generate on the free allowance", () => {
  it("holds the second draft while the first is unread, and says so", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null });
    firstDraftAwaitsReview.mockResolvedValue("Your first draft is waiting for your review.");
    const body = await (await GET(req())).json();
    expect(generateArticle).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("waiting for your review") });
  });
  it("writes once the first has been read", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null });
    const body = await (await GET(req())).json();
    expect(body.generated).toBe(1);
  });
  it("does not ask the question of a paid plan", async () => {
    getQuota.mockResolvedValue({ limit: 30, used: 1, remaining: 29, reason: "plan", plan: "starter" });
    firstDraftAwaitsReview.mockResolvedValue("would block");
    const body = await (await GET(req())).json();
    expect(firstDraftAwaitsReview).not.toHaveBeenCalled();
    expect(body.generated).toBe(1);
  });
});
