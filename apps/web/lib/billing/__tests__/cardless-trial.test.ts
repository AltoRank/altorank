import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

/**
 * The card-less trial (lib/billing/cardless-trial.ts): seven days of Managed
 * with no card, capped, and closed on its end date. The row is the card trial's
 * without a subscription, so these pin the places that tell the two apart.
 */

vi.mock("@/lib/billing/account-client", () => ({ accountCountingClient: (c: unknown) => c }));
vi.mock("@/lib/billing/operator-account", () => ({ accountHasOperator: async () => false }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/auth/preview", () => ({ inCustomerPreview: async () => false, customerPreviewPlan: async () => undefined }));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_cardless_trial";
});
afterEach(() => {
  delete process.env.CARDLESS_TRIAL_DISABLED;
});

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number, from = Date.now()) => new Date(from + days * DAY).toISOString();

/** An account row, `articles` written, and a site that is not paused. */
function client(account: Record<string, unknown>, articles = 1) {
  const chain = (name: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "neq", "gte", "lt", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () =>
      name === "accounts"
        ? { data: account, error: null }
        : { data: { account_id: "acc", status: "active", paused_until: null }, error: null };
    q.single = q.maybeSingle;
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve(name === "workspaces" ? { data: [{ id: "w1" }], count: 1, error: null } : { data: [], count: articles, error: null });
    return q;
  };
  return { from: (n: string) => chain(n) } as never;
}

const cardless = { plan: "starter", plan_status: "trialing", stripe_subscription_id: null, billing_provider: "stripe" };

describe("telling a card-less trial from a card trial", () => {
  it("is trialing with no subscription, and never a Shopify-billed store", async () => {
    const { isCardlessTrial } = await import("../cardless-trial");
    expect(isCardlessTrial({ ...cardless, trial_ends_at: inDays(5) })).toBe(true);
    expect(isCardlessTrial({ ...cardless, stripe_subscription_id: "sub_1" })).toBe(false);
    expect(isCardlessTrial({ ...cardless, billing_provider: "shopify" })).toBe(false);
    expect(isCardlessTrial({ ...cardless, plan_status: "active" })).toBe(false);
  });

  it("a card added keeps the trial's end, or Stripe's 48-hour floor when that is later", async () => {
    const { checkoutTrialEnd } = await import("../cardless-trial");
    const now = new Date("2026-11-02T12:00:00Z");
    const ends = inDays(5, now.getTime());
    expect(checkoutTrialEnd({ ...cardless, trial_ends_at: ends }, now)).toBe(Math.ceil(Date.parse(ends) / 1000));
    const lastDay = inDays(0.5, now.getTime());
    expect(checkoutTrialEnd({ ...cardless, trial_ends_at: lastDay }, now)).toBe(Math.ceil((now.getTime() + 49 * 60 * 60 * 1000) / 1000));
    expect(checkoutTrialEnd({ ...cardless, trial_ends_at: inDays(-1, now.getTime()) }, now)).toBeNull();
    expect(checkoutTrialEnd({ ...cardless, stripe_subscription_id: "sub_1", trial_ends_at: ends }, now)).toBeNull();
  });

  it("one site is one key, whatever the scheme or www", async () => {
    const { siteKey } = await import("../cardless-trial");
    expect(siteKey("https://www.Example.com/blog")).toBe("example.com");
    expect(siteKey("example.com")).toBe("example.com");
  });
});

describe("starting one", () => {
  function startDb(opts: { trialedElsewhere?: boolean; updated?: boolean } = {}) {
    const updates: Record<string, unknown>[] = [];
    const chain = (name: string): Record<string, unknown> => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "neq", "is", "not", "limit"]) q[m] = () => q;
      q.update = (row: Record<string, unknown>) => {
        updates.push(row);
        return q;
      };
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          name === "workspaces"
            ? { data: opts.trialedElsewhere ? [{ account_id: "other" }] : [], error: null }
            : { data: opts.updated === false ? [] : [{ id: "acc" }], error: null },
        );
      return q;
    };
    return { db: { from: (n: string) => chain(n) } as never, updates };
  }

  it("writes the trial as Managed, trialing, ending in seven days", async () => {
    const { startCardlessTrial } = await import("../cardless-trial");
    const { db, updates } = startDb();
    const now = new Date("2026-11-02T12:00:00Z");
    const out = await startCardlessTrial(db, { accountId: "acc", domains: ["example.com"] }, now);
    expect(out).toEqual({ ok: true, endsAt: "2026-11-09T12:00:00.000Z" });
    expect(updates).toEqual([{ plan: "starter", plan_status: "trialing", trial_ends_at: "2026-11-09T12:00:00.000Z" }]);
  });

  it("a site another account has trialed gets the card trial", async () => {
    const { startCardlessTrial } = await import("../cardless-trial");
    const { db, updates } = startDb({ trialedElsewhere: true });
    expect(await startCardlessTrial(db, { accountId: "acc", domains: ["example.com"] })).toEqual({ ok: false, reason: "site_trialed" });
    expect(updates).toEqual([]);
  });

  it("an account that already trialed is left as it is", async () => {
    const { startCardlessTrial } = await import("../cardless-trial");
    const { db } = startDb({ updated: false });
    expect(await startCardlessTrial(db, { accountId: "acc", domains: [] })).toEqual({ ok: false, reason: "not_eligible" });
  });

  it("the kill switch brings the card trial back", async () => {
    process.env.CARDLESS_TRIAL_DISABLED = "1";
    const { startCardlessTrial } = await import("../cardless-trial");
    const { db } = startDb();
    expect(await startCardlessTrial(db, { accountId: "acc", domains: [] })).toEqual({ ok: false, reason: "off" });
  });
});

describe("what the trial and the floor allow", () => {
  it("the trial is the plan, capped at its articles for its whole length", async () => {
    const { getQuota, quotaExceededMessage } = await import("../quota");
    const { CARDLESS_TRIAL_ARTICLES } = await import("../cardless-trial");
    const running = await getQuota(client({ ...cardless, trial_ends_at: inDays(5) }, 1), "acc", null);
    expect(running).toMatchObject({ reason: "plan", plan: "starter", limit: CARDLESS_TRIAL_ARTICLES, used: 1, remaining: CARDLESS_TRIAL_ARTICLES - 1 });
    expect(running.trial?.cardless).toBe(true);

    const capped = await getQuota(client({ ...cardless, trial_ends_at: inDays(5) }, CARDLESS_TRIAL_ARTICLES), "acc", null);
    expect(capped.remaining).toBe(0);
    expect(quotaExceededMessage(capped)).toMatch(/Add a card on the Billing page to keep writing/);
  });

  it("the cap stops drafting at the spend gate, so no research is bought for an article it cannot write", async () => {
    const { canSpend } = await import("../spend-gate");
    const { CARDLESS_TRIAL_ARTICLES } = await import("../cardless-trial");
    const db = client({ ...cardless, trial_ends_at: inDays(5) }, CARDLESS_TRIAL_ARTICLES);
    expect(await canSpend(db, "acc", { userEmail: null, workspaceId: "w1", action: "scheduled-work" })).toMatchObject({ allowed: false });
    // Reading and the other paid tools stay open while the trial runs.
    expect(await canSpend(db, "acc", { userEmail: null, workspaceId: "w1", action: "keyword-research" })).toMatchObject({ allowed: true });
  });

  it("a card trial keeps the plan's monthly volume", async () => {
    const { getQuota } = await import("../quota");
    const q = await getQuota(client({ ...cardless, stripe_subscription_id: "sub_1", trial_ends_at: inDays(5) }, 1), "acc", null);
    expect(q).toMatchObject({ reason: "plan", limit: 100 });
    expect(q.trial?.cardless).toBeUndefined();
  });

  it("after the trial: nothing new is written, as after a card trial", async () => {
    const { getQuota, quotaExceededMessage, PLAN_ENDED_MESSAGE } = await import("../quota");
    const q = await getQuota(client({ ...cardless, plan_status: "inactive", trial_ends_at: inDays(-1) }, 0), "acc", null);
    expect(q).toMatchObject({ reason: "no-plan", remaining: 0, trialEnded: true });
    expect(quotaExceededMessage(q)).toBe(PLAN_ENDED_MESSAGE);
  });
});

describe("what the offer says", () => {
  it("no card: the line says so, and what happens on the last day", async () => {
    const { priceLine, reassuranceLine, trialOfferFacts } = await import("../trial-offer");
    const facts = trialOfferFacts(new Date("2026-11-02T12:00:00Z"), false, true);
    expect(priceLine("month", facts)).toBe("No card needed. Free until November 9. Add a card to keep going at €69/month; without one it just ends.");
    expect(reassuranceLine(facts)).toMatch(/^The trial writes up to 4 articles\. Without a card it ends by itself/);
    expect(priceLine("month", trialOfferFacts(new Date("2026-11-02T12:00:00Z"), false))).toMatch(/^Card required\./);
  });

  it("the sidebar asks for the card", async () => {
    const { trialThenLabel } = await import("../trial");
    expect(trialThenLabel({ endsAt: inDays(3), daysLeft: 3, cardless: true }, "the Managed plan")).toBe("Trial ends in 3 days. Add a card to keep the Managed plan");
  });
});

describe("throwaway inboxes", () => {
  it("are refused, and real providers are not", async () => {
    const { isDisposableEmail } = await import("@/lib/auth/disposable-email");
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("X@Yopmail.com")).toBe(true);
    expect(isDisposableEmail("owner@gmail.com")).toBe(false);
    expect(isDisposableEmail("owner@example.in")).toBe(false);
  });
});
