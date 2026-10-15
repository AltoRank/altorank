import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  process.env.SHOPIFY_PARTNER_ORG_ID = "org1";
  process.env.SHOPIFY_PARTNER_API_TOKEN = "prtapi_x";
  process.env.SHOPIFY_APP_GID = "gid://shopify/App/9";
  return { oweResume: vi.fn(), queryShopify: vi.fn(), recordEvent: vi.fn() };
});
vi.mock("@/lib/plan/resume-week", () => ({ oweResume: m.oweResume }));
vi.mock("@/lib/cms/shopify", () => ({ queryShopify: m.queryShopify }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: m.recordEvent }));

import { accountFieldsFor, fetchActiveSubscription, planSelectionUrl, planTierFor, syncShopifyBilling } from "../billing";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const NOW = Date.parse("2026-10-15T12:00:00Z");
const sub = (over = {}) => ({ handle: "managed", trialEndsAt: null, cancelAtEndOfCycle: false, periodEnd: "2026-11-15T00:00:00Z", ...over });

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(m).forEach((f) => f.mockReset());
});

describe("plan mapping", () => {
  it("maps Shopify plan handles to tiers, and nothing else", () => {
    expect(planTierFor("managed")).toBe("starter");
    expect(planTierFor("agency")).toBe("growth");
    expect(planTierFor("pro", "pro:scale")).toBe("scale");
    expect(planTierFor("mystery")).toBeNull();
  });

  it("links to the Shopify-hosted plan page", () => {
    expect(planSelectionUrl("fern.myshopify.com")).toBe("https://admin.shopify.com/store/fern/charges/altorank/pricing_plans");
  });
});

describe("accountFieldsFor", () => {
  const free = { billing_provider: "stripe", stripe_subscription_id: null, plan_status: "inactive" };
  const shopifyPaid = { billing_provider: "shopify", stripe_subscription_id: null, plan_status: "active" };

  it("a subscription in its trial is `trialing`, with Shopify's end date", () => {
    expect(accountFieldsFor(sub({ trialEndsAt: "2026-10-20T00:00:00Z" }), free, NOW)).toMatchObject({
      billing_provider: "shopify",
      plan: "starter",
      plan_status: "trialing",
      trial_ends_at: "2026-10-20T00:00:00Z",
    });
  });

  it("a paid subscription is active; one set to end carries the date it ends", () => {
    expect(accountFieldsFor(sub(), free, NOW)).toMatchObject({ plan_status: "active", cancels_at: null });
    expect(accountFieldsFor(sub({ cancelAtEndOfCycle: true }), free, NOW)).toMatchObject({ cancels_at: "2026-11-15T00:00:00Z" });
  });

  it("never touches an account Stripe bills", () => {
    expect(accountFieldsFor(sub(), { billing_provider: "stripe", stripe_subscription_id: "sub_1", plan_status: "active" }, NOW)).toBeNull();
    expect(accountFieldsFor(null, { billing_provider: "stripe", stripe_subscription_id: "sub_1", plan_status: "active" }, NOW)).toBeNull();
  });

  it("no subscription cancels a Shopify-billed account and leaves a never-paid one alone", () => {
    expect(accountFieldsFor(null, shopifyPaid, NOW)).toEqual({ plan_status: "canceled", cancels_at: null });
    expect(accountFieldsFor(null, free, NOW)).toBeNull();
  });

  it("an unknown plan handle changes nothing", () => {
    expect(accountFieldsFor(sub({ handle: "mystery" }), free, NOW)).toBeNull();
  });
});

describe("fetchActiveSubscription", () => {
  it("asks the Partner API for this app and store", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { activeSubscription: { cancelAtEndOfCycle: false, trialEndsAt: null, currentBillingCycle: { endTime: "2026-11-01T00:00:00Z" }, items: [{ handle: "agency" }] } },
      }),
    });
    expect(await fetchActiveSubscription("gid://shopify/Shop/5")).toEqual({
      handle: "agency",
      trialEndsAt: null,
      cancelAtEndOfCycle: false,
      periodEnd: "2026-11-01T00:00:00Z",
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://partners.shopify.com/org1/api/2026-10/graphql.json");
    expect(init.headers["X-Shopify-Access-Token"]).toBe("prtapi_x");
    expect(JSON.parse(init.body).variables).toEqual({ appId: "gid://shopify/App/9", shopId: "gid://shopify/Shop/5" });
  });

  it("is null when the store has no subscription", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { activeSubscription: null } }) });
    expect(await fetchActiveSubscription("gid://shopify/Shop/5")).toBeNull();
  });
});

describe("syncShopifyBilling", () => {
  function fakeDb(account: Record<string, unknown>, sites: Record<string, unknown>[] = []) {
    const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
    const from = (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        update: (values: Record<string, unknown>) => (writes.push({ table, values }), b),
        single: async () => ({ data: account, error: null }),
        then: (res: (v: unknown) => void) => res({ data: table === "workspaces" ? sites : null, error: null }),
      };
      return b;
    };
    return { db: { from } as never, writes };
  }

  it("on a new trial: writes the plan, raises the sites' pace and owes the held drafts", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { activeSubscription: { cancelAtEndOfCycle: false, trialEndsAt: "2099-01-01T00:00:00Z", currentBillingCycle: null, items: [{ handle: "managed" }] } },
      }),
    });
    const { db, writes } = fakeDb({ billing_provider: "stripe", stripe_subscription_id: null, plan_status: "inactive" }, [
      { id: "ws1", auto_generate_weekly_limit: 7 },
    ]);
    const out = await syncShopifyBilling(db, { id: "inst-1", shop: "fern.myshopify.com", accountId: "acc-1", shopGid: "gid://shopify/Shop/5" });

    expect(writes.find((w) => w.table === "accounts")?.values).toMatchObject({ plan: "starter", plan_status: "trialing", billing_provider: "shopify" });
    expect(writes.some((w) => w.table === "workspaces")).toBe(true);
    expect(m.oweResume).toHaveBeenCalledWith(db, "acc-1", "shopify:gid://shopify/Shop/5:managed");
    expect(out.resume).toEqual({ accountId: "acc-1", key: "shopify:gid://shopify/Shop/5:managed", draftWeek: true });
  });

  it("an account already on the plan is only refreshed, with nothing re-owed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { activeSubscription: { cancelAtEndOfCycle: false, trialEndsAt: null, items: [{ handle: "managed" }] } } }),
    });
    const { db } = fakeDb({ billing_provider: "shopify", stripe_subscription_id: null, plan_status: "active" });
    const out = await syncShopifyBilling(db, { id: "inst-1", shop: "fern.myshopify.com", accountId: "acc-1", shopGid: "gid://shopify/Shop/5" });
    expect(out.resume).toBeNull();
    expect(m.oweResume).not.toHaveBeenCalled();
  });
});
