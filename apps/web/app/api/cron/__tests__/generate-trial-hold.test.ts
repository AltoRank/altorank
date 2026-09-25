import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * cron/generate and the trial hold (lib/billing/trial-hold.ts): a
 * trial-gated account's first article is the last thing written before its
 * trial, however many free drafts the old allowance would have left. And the
 * claim on a planned entry (lib/plan/draft-claim.ts): the scheduled writer
 * leaves a site alone while the trial resume is writing its week, never writes
 * an entry somebody else has claimed, and says on the entry when its own
 * draft failed.
 */

const { generateArticle, getQuota, recommendKeywords, duePlannedKeyword, claim, sweep, order, deferred } = vi.hoisted(() => ({
  generateArticle: vi.fn(),
  getQuota: vi.fn(),
  recommendKeywords: vi.fn(),
  duePlannedKeyword: vi.fn(),
  sweep: vi.fn(),
  order: [] as string[],
  deferred: [] as Array<() => unknown>,
  claim: {
    claimEntry: vi.fn(),
    claimsInFlight: vi.fn(),
    recordEntryFailure: vi.fn(),
    releaseClaim: vi.fn(),
  },
}));

let workspaces: Record<string, unknown>[] = [];
function table(name: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
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
  recommendKeywords: (...a: unknown[]) => recommendKeywords(...a),
  pickNextKeyword: (recs: { action: string; quality: string }[]) => recs.find((r) => r.action === "write" && r.quality === "ok") ?? null,
}));
vi.mock("@/lib/onboarding/plan", () => ({
  duePlannedKeyword: (...a: unknown[]) => duePlannedKeyword(...a),
  fulfilPlannedEntry: async () => {},
  closeCoveredEntries: async () => 0,
}));
vi.mock("@/lib/billing/quota", () => ({ getQuota: (...a: unknown[]) => getQuota(...a), quotaExceededMessage: () => "quota" }));
vi.mock("@/lib/billing/first-draft-gate", () => ({ firstDraftAwaitsReview: async () => null }));
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: async () => ({ allowed: true, reason: "free-allowance", quota: { limit: 7, remaining: 6 }, message: null }) }));
vi.mock("@/lib/billing/resume", () => ({ resumeExpiredPauses: async () => [], isoDay: (d: Date) => d.toISOString().slice(0, 10) }));
vi.mock("@/lib/stripe", () => ({ billingEnabled: true, getStripe: () => null, TRIAL_DAYS: 7 }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generateArticle(...a), ConcurrentGenerationError: class extends Error {} }));
vi.mock("@/lib/plan/pace-budget", () => ({ readPaceBudget: async () => ({ articlesLeft: 5 }), describePaceBudget: () => "" }));
vi.mock("@/lib/plan/frozen", () => ({ readFrozenEntries: async () => ({ ids: new Set(), reason: null }) }));
vi.mock("@/lib/plan/draft-claim", () => ({
  claimEntry: (...a: unknown[]) => claim.claimEntry(...a),
  claimsInFlight: (...a: unknown[]) => claim.claimsInFlight(...a),
  recordEntryFailure: (...a: unknown[]) => claim.recordEntryFailure(...a),
  releaseClaim: (...a: unknown[]) => claim.releaseClaim(...a),
}));
// The sweep that finishes an unfinished trial resume is its own contract
// (lib/plan/__tests__/resume-sweep.test.ts); here, only that it runs first
// and its lines reach the report.
vi.mock("@/lib/plan/resume-sweep", () => ({ sweepUnfinishedResumes: (...a: unknown[]) => (order.push("sweep"), sweep(...a)) }));
vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => unknown) => { deferred.push(fn); } };
});
vi.mock("@/lib/email/draft-batch", () => ({ announceDraftBatch: async () => "emailed", sweepUnannouncedDrafts: async () => [] }));
vi.mock("@/lib/email/schedule-events", () => ({
  announceNothingWritten: async () => "",
  announcePausedSites: async () => [],
  announceSetupUnfinished: async () => "",
  nothingWrittenReason: () => null,
  remindEndingPauses: async () => [],
  sweepUnfinishedSetups: async () => [],
}));

import { GET } from "../generate/route";
import { TRIAL_HOLD_MESSAGE, TrialHoldError } from "@/lib/billing/trial-hold";

const req = () => new Request("http://localhost/api/cron/generate", { headers: { "x-cron-secret": "s" } });
const GOOD = { term: "crm for agencies", keywordId: "k1", action: "write", quality: "ok", reasons: ["fixture"], score: 1, difficulty: 10, volume: 100 };

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  delete process.env.TRIAL_GATE_DISABLED;
  workspaces = [{ id: "ws-1", domain: "acme-agency.example", account_id: "acc-1", auto_generate_weekly_limit: 7, refresh_enabled: false, refresh_days: null, onboarded_at: "2026-09-22T10:00:00Z", onboarding_skipped_at: null }];
  generateArticle.mockReset().mockResolvedValue({ articleId: "art-2", title: "T", wordCount: 900, factCheck: { verdict: "clean" } });
  recommendKeywords.mockReset().mockResolvedValue([GOOD]);
  duePlannedKeyword.mockReset().mockResolvedValue(null);
  claim.claimEntry.mockReset().mockResolvedValue(true);
  claim.claimsInFlight.mockReset().mockResolvedValue(0);
  claim.recordEntryFailure.mockReset().mockResolvedValue(undefined);
  claim.releaseClaim.mockReset().mockResolvedValue(undefined);
  sweep.mockReset().mockResolvedValue({ lines: [], settled: Promise.resolve(), started: 0 });
  order.length = 0;
  deferred.length = 0;
});

describe("cron/generate and a trial-gated account", () => {
  it("writes nothing past the first article, buys no research for it, and says why", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null, trialEligible: true });
    const body = await (await GET(req())).json();
    expect(body.results[0]).toMatchObject({ status: "skipped", detail: TRIAL_HOLD_MESSAGE });
    expect(recommendKeywords).not.toHaveBeenCalled();
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("keeps writing for a trialing account", async () => {
    getQuota.mockResolvedValue({ limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" });
    const body = await (await GET(req())).json();
    expect(body.generated).toBe(1);
  });

  it("keeps the free allowance for a no-plan account that is not trial-gated", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null, trialEligible: false });
    const body = await (await GET(req())).json();
    expect(body.generated).toBe(1);
  });

  it("reports the hold as a skip when the writer itself refuses (a race the read above lost)", async () => {
    getQuota.mockResolvedValue({ limit: 7, used: 0, remaining: 7, reason: "no-plan", plan: null, trialEligible: true });
    duePlannedKeyword.mockResolvedValue({ entryId: "e1", keywordId: "k1", term: "crm for agencies" });
    generateArticle.mockRejectedValue(new TrialHoldError());
    const body = await (await GET(req())).json();
    expect(body.results[0]).toMatchObject({ status: "skipped", detail: TRIAL_HOLD_MESSAGE });
    expect(body.errors).toBe(0);
    expect(claim.recordEntryFailure).toHaveBeenCalledWith(expect.anything(), "e1", expect.stringMatching(/^cron:/), TRIAL_HOLD_MESSAGE);
  });
});

describe("cron/generate and claimed entries", () => {
  beforeEach(() => {
    getQuota.mockResolvedValue({ limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" });
  });

  it("leaves a site alone while the trial resume is writing its week", async () => {
    claim.claimsInFlight.mockResolvedValue(3);
    const body = await (await GET(req())).json();
    expect(body.results[0]).toMatchObject({ status: "skipped", detail: "3 planned drafts are being written right now; this run leaves the site to them" });
    expect(recommendKeywords).not.toHaveBeenCalled();
  });

  it("claims today's entry before writing it, and writes nothing when somebody else holds it", async () => {
    duePlannedKeyword.mockResolvedValue({ entryId: "e1", keywordId: "k1", term: "crm for agencies" });
    claim.claimEntry.mockResolvedValue(false);
    const body = await (await GET(req())).json();
    expect(claim.claimEntry).toHaveBeenCalledWith(expect.anything(), "e1", expect.stringMatching(/^cron:\d+$/));
    expect(body.results[0]).toMatchObject({ status: "skipped", detail: '"crm for agencies" is already being written by another run; leaving it to that one' });
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("writes a failed draft's reason on its entry, so the calendar says it and the next run takes it back", async () => {
    duePlannedKeyword.mockResolvedValue({ entryId: "e1", keywordId: "k1", term: "crm for agencies" });
    generateArticle.mockRejectedValue(new Error("The model timed out."));
    const body = await (await GET(req())).json();
    expect(body.results[0]).toMatchObject({ status: "error", detail: "The model timed out." });
    const [, entryId, by, reason] = claim.recordEntryFailure.mock.calls[0];
    expect([entryId, reason]).toEqual(["e1", "The model timed out."]);
    expect(by).toBe(claim.claimEntry.mock.calls[0][2]);
  });

  it("claims nothing for a keyword from the live queue: there is no entry to claim", async () => {
    const body = await (await GET(req())).json();
    expect(body.generated).toBe(1);
    expect(claim.claimEntry).not.toHaveBeenCalled();
  });
});

describe("cron/generate and a trial resume that was cut off", () => {
  beforeEach(() => {
    getQuota.mockResolvedValue({ limit: 100, used: 1, remaining: 99, reason: "plan", plan: "starter" });
  });

  it("sends it again before the loop, reports what it did, and stays up until its drafts have left", async () => {
    const settled = Promise.resolve();
    sweep.mockResolvedValue({ lines: ["ws-1: started the rest of the trial's week again, 3 drafts"], settled, started: 3 });
    claim.claimsInFlight.mockImplementation(async () => (order.push("loop"), 3));
    const body = await (await GET(req())).json();
    expect(order[0]).toBe("sweep");
    expect(body.resumes).toEqual(["ws-1: started the rest of the trial's week again, 3 drafts"]);
    // The loop then finds the site being written and leaves it alone.
    expect(body.results[0]).toMatchObject({ status: "skipped" });
    expect(deferred).toHaveLength(1);
  });

  it("keeps nothing alive when the sweep started nothing", async () => {
    await GET(req());
    expect(deferred).toHaveLength(0);
  });
});
