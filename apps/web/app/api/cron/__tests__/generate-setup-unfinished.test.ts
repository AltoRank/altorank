import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The first draft for a site whose wizard was never finished is announced by
 * the setup email, not the ordinary draft-ready one.
 *
 * The first real signup (2026-09-07) stopped at the CMS step and never came
 * back; the crons read the site and would have written a draft into a review
 * queue nobody knew existed. The setup email carries the draft *and* where
 * setup stopped, once per site. Every later draft, and every draft for a site
 * that finished or skipped the wizard, goes out the ordinary way.
 */

const { generateArticle, sendArticleDraftedEmails, announceSetupUnfinished, sweepUnfinishedSetups, announceNothingWritten } = vi.hoisted(
  () => ({
    generateArticle: vi.fn(),
    sendArticleDraftedEmails: vi.fn(),
    announceSetupUnfinished: vi.fn(),
    sweepUnfinishedSetups: vi.fn(),
    announceNothingWritten: vi.fn(),
  }),
);

let workspaces: Record<string, unknown>[] = [];

/** A thenable query chain: every filter returns itself, awaiting resolves per table. */
function table(name: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  const resolve = () => {
    if (name === "workspaces") return { data: workspaces, error: null };
    if (name === "articles") return { data: [], error: null };
    return { data: [], error: null };
  };
  Object.assign(chain, {
    select: self, eq: self, neq: self, gte: self, order: self, is: self, not: self, lt: self, in: self, limit: self,
    single: async () => ({ data: { topical_profile: { terms: { a: 1, b: 1, c: 1, d: 1 } } }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (r: (v: unknown) => unknown) => r(resolve()),
  });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (n: string) => table(n) }) }));
vi.mock("@/lib/seo/recommendations", () => ({
  recommendKeywords: async () => [
    { term: "content calendar template", keywordId: "kw-1", action: "write", quality: "ok", reasons: ["fixture"], score: 1, difficulty: 10, volume: 100 },
  ],
  pickNextKeyword: (recs: { action: string; quality: string }[]) => recs.find((r) => r.action === "write" && r.quality === "ok") ?? null,
}));
vi.mock("@/lib/onboarding/plan", () => ({ duePlannedKeyword: async () => null, fulfilPlannedEntry: async () => {} }));
vi.mock("@/lib/billing/quota", () => ({ getQuota: async () => ({ limit: null, remaining: null }), quotaExceededMessage: () => "quota" }));
// The cron asks the spend gate before it asks the quota (a lapsed card, a
// cancelled subscription and a paused account all stop it, not just an empty
// allowance). This fixture is an entitled account.
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
vi.mock("@/lib/email/agency-recipients", () => ({
  agencyRecipients: async () => ["owner@acme.co"],
  agencyBillingRecipients: async () => [],
  userEmail: async () => null,
}));
vi.mock("@/lib/email/article-emails", () => ({ sendArticleDraftedEmails: (...a: unknown[]) => sendArticleDraftedEmails(...a) }));
vi.mock("@/lib/email/schedule-events", () => ({
  announceNothingWritten: (...a: unknown[]) => announceNothingWritten(...a),
  announcePausedSites: async () => [],
  announceSetupUnfinished: (...a: unknown[]) => announceSetupUnfinished(...a),
  nothingWrittenReason: () => null,
  remindEndingPauses: async () => [],
  sweepUnfinishedSetups: (...a: unknown[]) => sweepUnfinishedSetups(...a),
}));

import { GET } from "../generate/route";

const DRAFT = { articleId: "art-1", title: "Content Calendar Template: A Practical Guide", wordCount: 400, factCheck: { verdict: "clean" } };

function request() {
  return new Request("http://localhost/api/cron/generate", { headers: { "x-cron-secret": "s" } });
}

beforeEach(() => {
  process.env.CRON_SECRET = "s";
  workspaces = [];
  generateArticle.mockReset().mockResolvedValue(DRAFT);
  sendArticleDraftedEmails.mockReset().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
  announceSetupUnfinished.mockReset().mockResolvedValue("emailed 1");
  sweepUnfinishedSetups.mockReset().mockResolvedValue([]);
  announceNothingWritten.mockReset().mockResolvedValue("emailed 1");
});

const stalled = {
  id: "ws-1", domain: "acme.com", agency_id: "ag-1", auto_generate_weekly_limit: 7,
  refresh_enabled: false, refresh_days: null, onboarded_at: null, onboarding_skipped_at: null,
};

describe("cron/generate and the stalled wizard", () => {
  it("writes the draft for a workspace still in setup and announces it with the setup email, not the draft-ready one", async () => {
    workspaces = [stalled];
    const body = await (await GET(request())).json();

    expect(body.generated).toBe(1);
    expect(generateArticle).toHaveBeenCalledTimes(1);
    expect(announceSetupUnfinished).toHaveBeenCalledWith(expect.anything(), { agencyId: "ag-1", workspaceId: "ws-1", domain: "acme.com" });
    expect(sendArticleDraftedEmails).not.toHaveBeenCalled();
    expect(body.results[0].detail).toContain("setup email: emailed 1");
  });

  it("announces the ordinary way once the wizard was finished", async () => {
    workspaces = [{ ...stalled, onboarded_at: "2026-09-07T10:00:00Z" }];
    await GET(request());
    expect(sendArticleDraftedEmails).toHaveBeenCalledTimes(1);
    expect(announceSetupUnfinished).not.toHaveBeenCalled();
  });

  /**
   * The draft-ready mail goes through sendOnce now, so the cron has to hand it
   * a client to claim against and the workspace it is about - without those the
   * ledger cannot key the send and the dedupe silently does nothing.
   */
  it("passes the client and the workspace scope to the draft-ready send", async () => {
    workspaces = [{ ...stalled, onboarded_at: "2026-09-07T10:00:00Z" }];
    await GET(request());
    const [client, recipients, payload, scope] = sendArticleDraftedEmails.mock.calls[0]!;
    expect(client).toBeTruthy();
    expect(recipients).toEqual(["owner@acme.co"]);
    expect(payload).toMatchObject({ articleId: "art-1", domain: "acme.com" });
    expect(scope).toEqual({ agencyId: "ag-1", workspaceId: "ws-1" });
  });

  it("treats a skipped wizard as finished for this purpose", async () => {
    workspaces = [{ ...stalled, onboarding_skipped_at: "2026-09-07T10:00:00Z" }];
    await GET(request());
    expect(sendArticleDraftedEmails).toHaveBeenCalledTimes(1);
    expect(announceSetupUnfinished).not.toHaveBeenCalled();
  });

  /** The sites this loop gave no draft to are swept afterwards, every run. */
  it("sweeps the stalled sites that got no draft, after the loop", async () => {
    workspaces = [];
    const body = await (await GET(request())).json();
    expect(sweepUnfinishedSetups).toHaveBeenCalledTimes(1);
    expect(body.setupNotices).toEqual([]);
  });

  /** A failed announcement is reported, never fatal: the draft exists. */
  it("keeps the draft when the setup email fails", async () => {
    workspaces = [stalled];
    announceSetupUnfinished.mockRejectedValue(new Error("mail down"));
    const body = await (await GET(request())).json();
    expect(body.generated).toBe(1);
    expect(body.results[0].detail).toContain("email failed (mail down)");
  });
});
