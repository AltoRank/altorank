import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The calendar promises a date, not a licence to write anything.
 *
 * `pickNextKeyword` is where the quality bar lives - it writes only what the
 * recommender marked `write`. A due calendar entry used to skip that check
 * entirely: whatever the plan named got written, however the recommender had
 * judged it. "business without websites" was queued for qasimcode.com on
 * 2026-09-09 and would have been written despite `commercialFit` refusing it,
 * because the plan had scheduled it before that check existed.
 */

const { generateArticle, duePlannedKeyword, fulfilPlannedEntry, closeCoveredEntries } = vi.hoisted(() => ({
  generateArticle: vi.fn(),
  duePlannedKeyword: vi.fn(),
  fulfilPlannedEntry: vi.fn(),
  closeCoveredEntries: vi.fn(),
}));

let workspaces: Record<string, unknown>[] = [];

function table(name: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  const resolve = () => (name === "workspaces" ? { data: workspaces, error: null } : { data: [], error: null });
  Object.assign(chain, {
    select: self, eq: self, neq: self, gte: self, order: self, is: self, not: self, lt: self, in: self, limit: self,
    single: async () => ({ data: { topical_profile: { terms: { a: 1, b: 1, c: 1, d: 1 } } }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (r: (v: unknown) => unknown) => r(resolve()),
  });
  return chain;
}

const REFUSED = {
  term: "business without websites",
  keywordId: "kw-bad",
  action: "skip",
  quality: "ok",
  reasons: ["argues against what this business sells"],
  score: 0.1, difficulty: 0, volume: 1600,
};
const GOOD = {
  term: "dental clinic website design",
  keywordId: "kw-good",
  action: "write",
  quality: "ok",
  reasons: ["720 searches/mo"],
  score: 9, difficulty: 41, volume: 720,
};

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: async () => [REFUSED, GOOD],
  pickNextKeyword: (recs: { action: string; quality: string }[]) =>
    recs.find((r) => r.action === "write" && r.quality === "ok") ?? null,
}));
vi.mock("@/lib/onboarding/plan", () => ({
  duePlannedKeyword: (...a: unknown[]) => duePlannedKeyword(...a),
  fulfilPlannedEntry: (...a: unknown[]) => fulfilPlannedEntry(...a),
  closeCoveredEntries: (...a: unknown[]) => closeCoveredEntries(...a),
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
  announceNothingWritten: async () => "",
  announcePausedSites: async () => [],
  announceSetupUnfinished: async () => "",
  nothingWrittenReason: () => null,
  remindEndingPauses: async () => [],
  sweepUnfinishedSetups: async () => [],
}));

import { GET } from "../generate/route";

const req = () => new Request("http://localhost/api/cron/generate", { headers: { "x-cron-secret": "s" } });
const wrote = () => generateArticle.mock.calls[0][0] as { keyword: string; keywordId: string | null };

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  workspaces = [{
    id: "ws-1", domain: "qasimcode.com", account_id: "ag-1", auto_generate_weekly_limit: 7,
    refresh_enabled: false, refresh_days: null,
    onboarded_at: "2026-09-07T10:00:00Z", onboarding_skipped_at: null,
  }];
  generateArticle.mockReset().mockResolvedValue({
    articleId: "art-1", title: "T", wordCount: 400, factCheck: { verdict: "clean" },
  });
  duePlannedKeyword.mockReset().mockResolvedValue(null);
  fulfilPlannedEntry.mockReset().mockResolvedValue(undefined);
  closeCoveredEntries.mockReset().mockResolvedValue(0);
});

describe("cron/generate — a plan entry the recommender refuses", () => {
  beforeEach(() => {
    duePlannedKeyword.mockResolvedValue({ entryId: "ce-1", keywordId: "kw-bad", term: REFUSED.term });
  });

  it("does not write it", async () => {
    await GET(req());
    expect(wrote().keyword).not.toBe(REFUSED.term);
  });

  it("still fills the slot the person was promised", async () => {
    const body = await (await GET(req())).json();
    expect(body.generated).toBe(1);
    expect(wrote().keyword).toBe(GOOD.term);
    expect(wrote().keywordId).toBe("kw-good");
  });

  it("closes the entry against the keyword it actually wrote", async () => {
    await GET(req());
    expect(fulfilPlannedEntry).toHaveBeenCalledWith(
      expect.anything(), "ce-1", "art-1", { term: GOOD.term, keywordId: "kw-good" },
    );
  });

  it("says in the run log that the plan was overruled, and why", async () => {
    const body = await (await GET(req())).json();
    expect(body.results[0].detail).toContain(REFUSED.term);
    expect(body.results[0].detail).toContain("argues against what this business sells");
  });
});

describe("cron/generate — a plan entry the recommender stands behind", () => {
  it("writes exactly what the calendar promised", async () => {
    duePlannedKeyword.mockResolvedValue({ entryId: "ce-2", keywordId: "kw-good", term: GOOD.term });
    await GET(req());
    expect(wrote().keyword).toBe(GOOD.term);
    // The entry already names this keyword; nothing to rewrite.
    expect(fulfilPlannedEntry).toHaveBeenCalledWith(expect.anything(), "ce-2", "art-1", undefined);
  });

  it("prefers the plan's own keyword row, which carries the owner's brief", async () => {
    duePlannedKeyword.mockResolvedValue({ entryId: "ce-2", keywordId: "kw-brief", term: GOOD.term });
    await GET(req());
    expect(wrote().keywordId).toBe("kw-brief");
  });

  it("leaves the log free of an overrule note", async () => {
    duePlannedKeyword.mockResolvedValue({ entryId: "ce-2", keywordId: "kw-good", term: GOOD.term });
    const body = await (await GET(req())).json();
    expect(body.results[0].detail).not.toContain("the plan asked for");
  });
});

describe("cron/generate — housekeeping", () => {
  it("retires entries the live queue already covered, before asking what is due", async () => {
    await GET(req());
    expect(closeCoveredEntries).toHaveBeenCalledWith(expect.anything(), "ws-1");
  });

  it("still writes the draft when that housekeeping throws", async () => {
    closeCoveredEntries.mockRejectedValue(new Error("boom"));
    const body = await (await GET(req())).json();
    expect(body.generated).toBe(1);
  });
});
