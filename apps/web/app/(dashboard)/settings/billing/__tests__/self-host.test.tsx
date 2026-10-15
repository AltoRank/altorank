// A self-hosted install (billing off) has no plan to buy. The Billing page used
// to say "No plan" and offer Choose Managed / Choose Agency, whose every click
// failed at checkout. It now says the install is self-hosted and shows no
// ladder and no invoices.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Quota } from "@/lib/billing/quota";

const state: { quota: Partial<Quota> } = { quota: {} };

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/billing" }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ accountId: "acc-1", user: { id: "u-1", email: "owner@example.org" }, role: "owner" }),
}));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/auth/preview", () => ({ getOperatorPreview: async () => null }));
vi.mock("@/lib/billing/subscription-interval", () => ({ readSubscriptionInterval: async () => null }));
vi.mock("@/lib/billing/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/quota")>()),
  getQuota: async () => state.quota,
}));
vi.mock("../plan-cards", () => ({ PlanCards: () => "PLAN-LADDER" }));
vi.mock("../retention-card", () => ({ RetentionCard: () => "RETENTION" }));
vi.mock("../dunning-card", () => ({ DunningCard: () => "DUNNING" }));

// Every query the page makes resolves to the row an account with no plan has.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const result =
        table === "accounts"
          ? { data: { plan: null, plan_status: "inactive", current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null, cancels_at: null, payment_failed_at: null }, error: null }
          : { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "not"]) chain[m] = () => chain;
      chain.single = async () => result;
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
  }),
}));

import BillingPage from "../page";

async function render(): Promise<string> {
  return renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));
}

describe("Billing page", () => {
  beforeEach(() => {
    state.quota = {};
  });

  it("on a self-hosted install, says so and offers no plan or invoices", async () => {
    state.quota = { limit: null, used: 3, remaining: null, reason: "self-host", plan: null };
    const html = await render();
    expect(html).toContain("Self-hosted · no plan needed");
    expect(html).toContain("This install is self-hosted, with billing turned off.");
    expect(html).not.toContain("No plan<");
    expect(html).not.toContain("PLAN-LADDER");
    expect(html).not.toContain("Choose a plan");
    expect(html).not.toContain("Recent invoices");
  });

  it("with billing on and no plan, still shows the plan ladder", async () => {
    state.quota = { limit: 7, used: 1, remaining: 6, reason: "no-plan", plan: null, trialEligible: true };
    const html = await render();
    expect(html).toContain("No plan");
    expect(html).toContain("PLAN-LADDER");
    expect(html).toContain("Recent invoices");
    expect(html).not.toContain("self-hosted");
  });
});
