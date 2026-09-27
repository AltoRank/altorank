/**
 * Topic qualification asks the spend gate itself.
 *
 * Round-4 review: the nightly pool refill, the planner's top-up and a resumed
 * site each reached qualification before anything asked whether the account
 * could spend, and every call buys a model verdict and a results page per
 * term. For an account waiting for its trial - its one pre-trial article
 * already attempted - a client token changing the business profile or adding
 * keywords re-bought all of it, every night.
 *
 * The real gate runs here (canSpendOnSite -> canSpend -> getQuota ->
 * trialGateApplies); only the database and the paid providers are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.STRIPE_SECRET_KEY = "sk_test_qualification_gate";
delete process.env.TRIAL_GATE_DISABLED;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { ask, judge, fetchSerp } = vi.hoisted(() => ({ ask: vi.fn(), judge: vi.fn(), fetchSerp: vi.fn() }));
vi.mock("../buyer-model", async (original) => ({ ...(await original<object>()), modelAvailable: () => true, askStructured: ask }));
vi.mock("../buyer-fit", async (original) => ({ ...(await original<object>()), judgeBuyerFit: judge }));
vi.mock("@/lib/seo/client", () => ({ hasDataForSEOCredentials: () => true }));
vi.mock("@/lib/seo/brief-data", () => ({ fetchAdvancedSerp: fetchSerp }));

const { qualifyOpportunities } = await import("../opportunity");
const { SpendRefusedError } = await import("@/lib/billing/spend-gate");
const { TRIAL_SPEND_MESSAGE } = await import("@/lib/billing/trial-refusal");

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const writes: unknown[] = [];

/** A PostgREST stand-in that applies the filters these reads use. */
function fakeClient() {
  return {
    from: (table: string) => {
      let rows = [...(tables[table] ?? [])];
      let head = false;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: (_c?: string, opts?: { head?: boolean }) => {
          head = Boolean(opts?.head);
          return q;
        },
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          rows = rows.filter((r) => vals.includes(r[col]));
          return q;
        },
        neq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] !== val);
          return q;
        },
        gte: () => q,
        not: () => q,
        order: () => q,
        range: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        update: (row: unknown) => {
          writes.push(row);
          return q;
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve(head ? { data: null, count: rows.length, error: null } : { data: rows, count: rows.length, error: null }),
      });
      return q;
    },
    auth: {
      getUser: async () => ({ data: { user: null } }),
      admin: { getUserById: async () => ({ data: { user: { email: "owner@client.example" } }, error: null }) },
    },
  } as never;
}

const context = {
  domain: "acme-agency.example",
  languageCode: "en",
  locationCode: 2840,
  business: { name: "Acme Agency", description: "Acme Agency builds booking websites for clinics at a fixed price.", offerings: ["clinic booking websites"], audiences: ["clinic owners"] },
};

function seed(freeDraftsUsed: number) {
  tables = {
    workspaces: [{ id: "ws", account_id: "acc", status: "active", paused_until: null }],
    // Never trialed, no plan: the trial gate applies.
    accounts: [{ id: "acc", plan: "starter", plan_status: "inactive", trial_ends_at: null, stripe_subscription_id: null, free_drafts_used: freeDraftsUsed, created_by: "u-owner" }],
    articles: [],
    keywords: [],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  writes.length = 0;
  judge.mockResolvedValue({ basis: "model", verdicts: new Map() });
  const { clearOperatorAccountCache } = await import("@/lib/billing/operator-account");
  clearOperatorAccountCache();
});

describe("qualification and the spend gate", () => {
  it("refuses, before buying anything, for an account whose pre-trial article is attempted", async () => {
    seed(1);
    const run = qualifyOpportunities(fakeClient(), "ws", [{ id: "k", term: "clinic booking website costs" }], context);
    await expect(run).rejects.toBeInstanceOf(SpendRefusedError);
    await expect(
      qualifyOpportunities(fakeClient(), "ws", [{ id: "k", term: "clinic booking website costs" }], context),
    ).rejects.toThrow(TRIAL_SPEND_MESSAGE);
    expect(judge).not.toHaveBeenCalled();
    expect(fetchSerp).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("buys for the same account during its setup, before the article is attempted", async () => {
    seed(0);
    await qualifyOpportunities(fakeClient(), "ws", [{ id: "k", term: "clinic booking website costs" }], context);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when every term already has a current verdict", async () => {
    seed(1);
    // Nothing to buy, so nothing to refuse: the cached answers are returned.
    const out = await qualifyOpportunities(fakeClient(), "ws", [], context);
    expect(out.size).toBe(0);
  });
});
