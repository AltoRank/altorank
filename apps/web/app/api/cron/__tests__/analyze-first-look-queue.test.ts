/**
 * cron/analyze's first-look queue and the spend gate.
 *
 * Round-4 review: the queue was ordered by attempts and age, three rows a
 * night, and a site the spend gate refused was skipped without a stamp. Every
 * account that has its pre-trial article is refused, so three such sites
 * whose crawl read nothing held the three slots every night, and every other
 * site's first look waited behind them for good.
 *
 * The real gate decides here (canSpend -> getQuota -> trialGateApplies), on
 * an in-memory database that applies the query's filters and order. The site
 * read itself is a stand-in: it is what would be bought.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/plan/__tests__/fake-postgrest";

process.env.STRIPE_SECRET_KEY = "sk_test_first_look_queue";
delete process.env.TRIAL_GATE_DISABLED;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { analysed, state } = vi.hoisted(() => ({
  analysed: [] as string[],
  state: { db: null as unknown as { client: never } },
}));

vi.mock("@/lib/cron-auth", () => ({ isAuthorizedCron: () => true }));
vi.mock("@/lib/observability/cron", () => ({ observedCron: (_name: string, fn: unknown) => fn }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => state.db.client }));
vi.mock("@/lib/audit/domain-analysis", () => ({
  analyseDomain: async ({ domain }: { domain: string }) => {
    analysed.push(domain);
    return { firstLook: { reason: "read", attempts: 1 }, headline: "", readiness: null, pagesCrawled: 3, keywordsFound: 0, layers: [] };
  },
}));
vi.mock("@/lib/gsc/seed", () => ({ seedKeywordsFromSearchConsole: async () => ({ inserted: 0 }) }));
vi.mock("@/lib/onboarding/run-store", () => ({ reapStaleRuns: async () => ({ reaped: 0, runIds: [] }) }));
vi.mock("@/lib/audit/profile-refresh", () => ({
  PROFILE_MAX_AGE_DAYS: 30,
  refreshTopicalProfile: async () => ({ status: "refreshed" }),
  selectStale: () => [],
}));
vi.mock("@/lib/onboarding/plan", () => ({ monthlyTarget: () => 0, schedulePlan: async () => [] }));
vi.mock("@/lib/seo/recommendations", () => ({ recommendKeywords: async () => [], pickNextKeyword: () => null }));
vi.mock("@/lib/keyword-research/top-up", () => ({ topUpKeywords: async () => ({ candidates: 0, priced: 0, inserted: 0, bySource: { ideas: 0, playbook: 0 } }) }));

const { GET } = await import("../analyze/route");

const site = (id: string, account: string, created: string) => ({
  id,
  account_id: account,
  domain: `${id}.example`,
  status: "active",
  auto_generate: false,
  first_analysed_at: null,
  analysis_attempts: 0,
  last_analysis_attempt_at: null,
  created_at: created,
  language: "en",
  location_code: 2840,
});

function seed() {
  state.db = new FakeDb({
    accounts: [
      // Waiting for its trial, its one article already attempted: refused.
      { id: "gated", plan: "starter", plan_status: "inactive", trial_ends_at: null, stripe_subscription_id: null, free_drafts_used: 1 },
      // Paying: its sites are owed their first look.
      { id: "paying", plan: "growth", plan_status: "active", trial_ends_at: null, stripe_subscription_id: "sub_1", free_drafts_used: 0 },
    ],
    // The gated account's sites are the OLDEST, so the old order put them first.
    workspaces: [
      site("gated-1", "gated", "2026-09-01T00:00:00Z"),
      site("gated-2", "gated", "2026-09-02T00:00:00Z"),
      site("gated-3", "gated", "2026-09-03T00:00:00Z"),
      site("gated-4", "gated", "2026-09-04T00:00:00Z"),
      site("paying-1", "paying", "2026-09-20T00:00:00Z"),
      site("paying-2", "paying", "2026-09-21T00:00:00Z"),
    ],
    articles: [],
  }) as never;
}

beforeEach(async () => {
  analysed.length = 0;
  seed();
  const { clearOperatorAccountCache } = await import("@/lib/billing/operator-account");
  clearOperatorAccountCache();
});

const run = async () => (await GET(new Request("http://localhost/api/cron/analyze"))).json();

describe("the first-look queue", () => {
  it("does not let refused sites hold the night's slots", async () => {
    const body = await run();
    expect(analysed.sort()).toEqual(["paying-1.example", "paying-2.example"]);
    expect(body.refused).toBe(4);
    expect(body.analysed).toBe(2);
  });

  it("moves a refused site to the back without counting an attempt", async () => {
    await run();
    const db = state.db as unknown as FakeDb;
    const refused = db.rows("workspaces").filter((w) => w.account_id === "gated");
    for (const w of refused) {
      expect(w.last_analysis_attempt_at).toEqual(expect.any(String));
      expect(w.analysis_attempts).toBe(0);
      expect(w.first_analysed_at).toBeNull();
    }
  });

  it("never buys a first look for an account the gate refuses", async () => {
    // Only the gated account's sites are waiting.
    const db = state.db as unknown as FakeDb;
    db.tables.workspaces = db.rows("workspaces").filter((w) => w.account_id === "gated");
    await run();
    expect(analysed).toEqual([]);
  });
});
