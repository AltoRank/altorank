import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * When nothing is written, the run log says what the verdicts added up to.
 *
 * Six nights after #214 the log for altorank.co read "no keyword qualifies:
 * all are covered, already ranking, or flagged as provider noise" while the
 * truth was sixty-four terms pending for want of a business profile. A
 * pending pool is our problem and is worded as such, and it does not email
 * the customer that their queue is exhausted.
 */

const { generateArticle, announceNothingWritten, nothingWrittenReason, recommend, spendRows, reporter } = vi.hoisted(() => ({
  generateArticle: vi.fn(),
  announceNothingWritten: vi.fn(async (...args: unknown[]) => String(args.length && "")),
  nothingWrittenReason: vi.fn((...args: unknown[]): string | null => (args.length ? null : null)),
  recommend: vi.fn(),
  spendRows: [] as unknown[],
  reporter: { armed: null as null | ((e: { operation: string; costUsd: number | null }) => void) },
}));

let workspaces: Record<string, unknown>[] = [];

function table(name: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  const resolve = () => (name === "workspaces" ? { data: workspaces, error: null } : { data: [], error: null });
  Object.assign(chain, {
    select: self, eq: self, neq: self, gte: self, order: self, is: self, not: self, lt: self, in: self, limit: self,
    insert: async (row: unknown) => { if (name === "provider_spend") spendRows.push(row); return { error: null }; },
    single: async () => ({ data: { topical_profile: { terms: { a: 1, b: 1, c: 1, d: 1 } } }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (r: (v: unknown) => unknown) => r(resolve()),
  });
  return chain;
}

const verdict = (status: string, cause: string, reason = "r") => ({ version: 2, context: "c", checkedAt: new Date().toISOString(), status, cause, reason });
const rec = (term: string, opportunity: unknown) => ({ term, keywordId: `kw-${term}`, action: "skip", quality: "ok", reasons: ["pending"], score: 1, difficulty: 10, volume: 100, opportunity });

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/seo/client", () => ({
  setSpendReporter: (fn: typeof reporter.armed) => { reporter.armed = fn; },
  hasDataForSEOCredentials: () => true,
}));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: (...a: unknown[]) => recommend(...a),
  pickNextKeyword: (recs: { action: string; quality: string }[]) => recs.find((r) => r.action === "write" && r.quality === "ok") ?? null,
}));
vi.mock("@/lib/onboarding/plan", () => ({
  duePlannedKeyword: async () => null,
  fulfilPlannedEntry: async () => undefined,
  closeCoveredEntries: async () => 0,
}));
vi.mock("@/lib/billing/quota", () => ({ getQuota: async () => ({ limit: null, remaining: null }), quotaExceededMessage: () => "quota" }));
vi.mock("@/lib/billing/spend-gate", () => ({
  canSpend: async () => ({ allowed: true, reason: "plan", quota: { limit: null, remaining: null }, message: null }),
}));
vi.mock("@/lib/billing/resume", () => ({ resumeExpiredPauses: async () => [], isoDay: (d: Date) => d.toISOString().slice(0, 10) }));
vi.mock("@/lib/stripe", () => ({ billingEnabled: false, getStripe: () => null }));
vi.mock("@/lib/content/generate", () => ({
  generateArticle: (...a: unknown[]) => generateArticle(...a),
  ConcurrentGenerationError: class extends Error {},
}));
vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ articlesLeft: 1 }), describePaceBudget: () => "" }));
vi.mock("@/lib/plan/frozen", () => ({ readFrozenEntries: async () => ({ ids: new Set(), reason: null }) }));
vi.mock("@/lib/email/account-recipients", () => ({
  accountRecipients: async () => ["owner@acme.co"],
  accountBillingRecipients: async () => [],
  userEmail: async () => null,
}));
vi.mock("@/lib/email/article-emails", () => ({ sendArticleDraftedEmails: async () => ({ sent: 1, skipped: 0, failed: 0 }) }));
vi.mock("@/lib/email/schedule-events", () => ({
  announceNothingWritten: (...a: unknown[]) => announceNothingWritten(...a),
  announcePausedSites: async () => [],
  announceSetupUnfinished: async () => "",
  nothingWrittenReason: (...a: unknown[]) => nothingWrittenReason(...a),
  remindEndingPauses: async () => [],
  sweepUnfinishedSetups: async () => [],
}));

import { GET } from "../generate/route";

const req = () => new Request("http://localhost/api/cron/generate", { headers: { "x-cron-secret": "s" } });
const detailOf = async () => {
  const body = await (await GET(req())).json();
  return body.results[0].detail as string;
};

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  workspaces = [{
    id: "ws-1", domain: "altorank.co", account_id: "ag-1", auto_generate_weekly_limit: 7,
    refresh_enabled: false, refresh_days: null, onboarded_at: "2026-09-07T10:00:00Z", onboarding_skipped_at: null,
  }];
  generateArticle.mockReset();
  recommend.mockReset();
  nothingWrittenReason.mockReset().mockReturnValue(null);
  spendRows.length = 0;
});

describe("cron/generate — what the verdicts add up to", () => {
  it("reports a pending pool as pending, with the cause, and does not call it exhausted", async () => {
    recommend.mockResolvedValue([rec("seo services", verdict("pending", "no_profile")), rec("freelance seo", verdict("pending", "no_profile")), rec("seo agency", verdict("rejected", "buyer_mismatch"))]);
    const detail = await detailOf();
    expect(detail).toBe("topic qualification pending: 0 qualified, 1 rejected (1 not a buyer search), 2 pending (2 no business profile)");
    expect(nothingWrittenReason).toHaveBeenCalledWith(detail);
  });

  it("reports a pool the buyer test refused as exhausted, with the causes", async () => {
    recommend.mockResolvedValue([rec("shipping", verdict("rejected", "buyer_mismatch")), rec("print labels", verdict("rejected", "not_editorial"))]);
    expect(await detailOf()).toBe("no keyword qualifies: 0 qualified, 2 rejected (1 not a buyer search, 1 the results are not articles), 0 pending");
  });

  it("keeps the old sentence for a pool nothing has judged yet", async () => {
    recommend.mockResolvedValue([rec("x", undefined)]);
    expect(await detailOf()).toBe("no keyword qualifies: all are covered, already ranking, or flagged as provider noise");
  });

  it("asks for the recommendations with qualification on, with a spend reporter armed for the workspace", async () => {
    recommend.mockImplementation(async () => {
      // A DataForSEO call made during qualification reports through the client's hook.
      reporter.armed?.({ operation: "/dataforseo_labs/google/x/live", costUsd: 0.0123 });
      return [];
    });
    await GET(req());
    await new Promise((r) => setTimeout(r, 0));
    expect(recommend).toHaveBeenCalledWith(expect.anything(), "ws-1", { limit: 1000, qualify: true });
    expect(spendRows).toEqual([expect.objectContaining({ provider: "dataforseo", workspace_id: "ws-1", operation: "/dataforseo_labs/google/x/live", cost_usd: 0.0123 })]);
    // And nothing stays armed once the run is over.
    expect(reporter.armed).toBeNull();
  });
});
