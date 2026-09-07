import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Quota } from "../quota";
import { FREE_DRAFTS, spentUnderOldMonthlyRule } from "../quota";

// ---------------------------------------------------------------------------
// The spend gate, branch by branch
// ---------------------------------------------------------------------------
//
// `canSpend` delegates the plan/operator/self-host/dunning resolution to
// getQuota, so the quota is stubbed and this file tests the decision the gate
// makes on top of it: which reasons allow, which refuse, what the refusal
// says, and that the pause outranks a paid plan.

const getQuota = vi.fn<(...args: unknown[]) => Promise<Quota>>();
vi.mock("@/lib/billing/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../quota")>();
  return { ...actual, getQuota: (...args: unknown[]) => getQuota(...args) };
});

const { canSpend } = await import("../spend-gate");

const quota = (over: Partial<Quota> = {}): Quota => ({
  limit: null,
  used: 0,
  remaining: null,
  reason: "plan",
  plan: "starter",
  ...over,
});

const freeTier = (used: number, over: Partial<Quota> = {}): Quota =>
  quota({
    limit: FREE_DRAFTS,
    used,
    remaining: Math.max(0, FREE_DRAFTS - used),
    reason: "no-plan",
    plan: null,
    monthUsed: used,
    ...over,
  });

/** A client whose only job is answering the workspace pause lookup. */
function client(paused: { status: string; paused_until: string | null } | null = null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: paused }) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => getQuota.mockReset());

describe("canSpend — allowed", () => {
  it("self-host always spends: that install pays its own provider bills", async () => {
    getQuota.mockResolvedValue(quota({ reason: "self-host", plan: null }));
    const d = await canSpend(client(), "a", { action: "keyword-research" });
    expect(d).toMatchObject({ allowed: true, reason: "self-host", message: null });
  });

  it("an operator account is never metered", async () => {
    getQuota.mockResolvedValue(quota({ reason: "operator", plan: null }));
    expect(await canSpend(client(), "a")).toMatchObject({ allowed: true, reason: "operator" });
  });

  it("an active plan spends", async () => {
    getQuota.mockResolvedValue(quota({ limit: 100, used: 4, remaining: 96 }));
    expect(await canSpend(client(), "a")).toMatchObject({ allowed: true, reason: "plan" });
  });

  it("a paid account past its included volume still spends: the overage is the answer", async () => {
    // Refusing here would turn "the next article bills as overage" into a
    // paywall. The cron's own limit is what stops unattended writing.
    getQuota.mockResolvedValue(quota({ limit: 100, used: 100, remaining: 0 }));
    expect(await canSpend(client(), "a")).toMatchObject({ allowed: true, reason: "plan" });
  });

  it("past due inside the grace window keeps the paid tier", async () => {
    getQuota.mockResolvedValue(
      quota({ limit: 100, used: 1, remaining: 99, dunning: { state: "grace", graceEndsAt: "2026-09-14T00:00:00.000Z" } }),
    );
    const d = await canSpend(client(), "a");
    expect(d).toMatchObject({ allowed: true, reason: "grace" });
  });

  it("a free account with drafts left may research, audit and look things up", async () => {
    getQuota.mockResolvedValue(freeTier(3));
    for (const action of ["keyword-research", "site-audit", "serp-lookup", "draft"] as const) {
      expect(await canSpend(client(), "a", { action })).toMatchObject({
        allowed: true,
        reason: "free-allowance",
      });
    }
  });
});

describe("canSpend — refused", () => {
  it("refuses once the one-time free drafts are spent, and says what to do", async () => {
    getQuota.mockResolvedValue(freeTier(FREE_DRAFTS));
    const d = await canSpend(client(), "a", { action: "keyword-research" });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.reason).toBe("free-allowance-spent");
    expect(d.message).toContain("Keyword research needs a plan");
    expect(d.message).toContain("Billing page");
    // The read-only half of the product is named, because "everything is
    // locked" is the wrong thing to believe here.
    expect(d.message).toContain("Reading everything already on the account stays free");
  });

  it("names the noun of the action that was refused", async () => {
    getQuota.mockResolvedValue(freeTier(FREE_DRAFTS));
    const audit = await canSpend(client(), "a", { action: "site-audit" });
    const backlinks = await canSpend(client(), "a", { action: "backlink-lookup" });
    expect(audit.allowed || backlinks.allowed).toBe(false);
    if (audit.allowed || backlinks.allowed) return;
    expect(audit.message).toContain("Re-crawling the site");
    expect(backlinks.message).toContain("Checking backlinks");
  });

  it("a refused draft gets the quota sentence, not the generic one", async () => {
    getQuota.mockResolvedValue(freeTier(FREE_DRAFTS));
    const d = await canSpend(client(), "a", { action: "draft" });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.message).toContain(`All ${FREE_DRAFTS} free drafts are used`);
    // The old sentence offered "wait for Oct 1, when the allowance resets".
    // It does not reset any more, so the date must be gone.
    expect(d.message).not.toMatch(/resets|wait for/i);
  });

  it("past due beyond the grace window is a card problem, not a plan problem", async () => {
    getQuota.mockResolvedValue(
      freeTier(FREE_DRAFTS, { dunning: { state: "lapsed", graceEndsAt: "2026-09-01T00:00:00.000Z" } }),
    );
    // Only once the free allowance is gone too: see the ordering note in
    // spend-gate.ts. The test below pins the other half of that rule.
    const d = await canSpend(client(), "a", { action: "refresh" });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.reason).toBe("past-due");
    expect(d.message).toContain("renewal payment did not go through");
    expect(d.message).toContain("Update the card");
    expect(d.message).toContain("September 1");
    // Offering Checkout to somebody who already has a subscription is how an
    // account ends up paying twice (2026-09-06).
    expect(d.message).not.toMatch(/choose a plan/i);
  });

  it("honours the free tier a lapsed card is told it has fallen back to", async () => {
    // The dunning banner says "the account is on the free tier until the card
    // is updated". An account with drafts left really does keep them, or the
    // banner is describing a product that refuses everything.
    getQuota.mockResolvedValue(
      freeTier(2, { dunning: { state: "lapsed", graceEndsAt: "2026-09-01T00:00:00.000Z" } }),
    );
    expect(await canSpend(client(), "a", { action: "draft" })).toMatchObject({
      allowed: true,
      reason: "free-allowance",
    });
  });

  it("a cancelled subscription falls back to the free allowance, which its history has spent", async () => {
    // getQuota drops a cancelled account to `no-plan` with its lifetime count
    // intact, so `used` is far past the free limit.
    getQuota.mockResolvedValue(freeTier(0, { used: 412, remaining: 0, monthUsed: 0 }));
    const d = await canSpend(client(), "a", { action: "keyword-research" });
    expect(d).toMatchObject({ allowed: false, reason: "free-allowance-spent" });
  });

  it("a paused account is refused even on an active plan", async () => {
    // The pause is a two-sided promise: "Billing and article generation
    // pause". Paying nothing must mean costing nothing.
    getQuota.mockResolvedValue(quota({ limit: 100, used: 3, remaining: 97 }));
    const d = await canSpend(client({ status: "paused", paused_until: "2026-10-03" }), "a", {
      workspaceId: "w",
      action: "draft",
    });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.reason).toBe("paused");
    expect(d.message).toContain("October 3");
  });

  it("a site paused by hand is not an account pause and does not block", async () => {
    // `paused_until` without `status = 'paused'` is somebody pausing one site
    // from its own settings, which keeps its settings and is not billing's
    // business (the same pairing generate.ts uses).
    getQuota.mockResolvedValue(quota({ limit: 100, used: 3, remaining: 97 }));
    const d = await canSpend(client({ status: "on", paused_until: "2026-10-03" }), "a", { workspaceId: "w" });
    expect(d).toMatchObject({ allowed: true, reason: "plan" });
  });

  it("self-host is never blocked by a pause", async () => {
    getQuota.mockResolvedValue(quota({ reason: "self-host", plan: null }));
    const d = await canSpend(client({ status: "paused", paused_until: "2026-10-03" }), "a", { workspaceId: "w" });
    expect(d).toMatchObject({ allowed: true, reason: "self-host" });
  });

  it("never answers with a bare code or an empty string", async () => {
    getQuota.mockResolvedValue(freeTier(FREE_DRAFTS));
    for (const action of [
      "draft",
      "keyword-research",
      "keyword-scoring",
      "site-audit",
      "voice-training",
      "serp-lookup",
      "backlink-lookup",
      "refresh",
      "recommendations",
      "geo-probe",
      "scheduled-work",
    ] as const) {
      const d = await canSpend(client(), "a", { action });
      expect(d.allowed).toBe(false);
      if (d.allowed) continue;
      expect(d.message.length).toBeGreaterThan(60);
      expect(d.message).toMatch(/Billing page|self-host/);
      expect(d.message).not.toMatch(/^[0-9a-f]{8,}$/);
    }
  });
});

describe("the mid-month rule change is explained, not silent", () => {
  it("tells an account that had drafts left under the monthly rule what changed", async () => {
    // Seven in August, seven in September: nothing left under the one-time
    // rule, one left under the old one. Locking that account without saying
    // why is a button that stopped working.
    getQuota.mockResolvedValue(freeTier(0, { used: 14, remaining: 0, monthUsed: 6 }));
    const d = await canSpend(client(), "a", { action: "draft" });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.message).toContain("used to refill on the 1st");
  });

  it("says nothing extra to an account that spent them under the current rule", async () => {
    getQuota.mockResolvedValue(freeTier(FREE_DRAFTS, { monthUsed: FREE_DRAFTS }));
    const d = await canSpend(client(), "a", { action: "draft" });
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.message).not.toContain("used to refill");
  });

  it("spentUnderOldMonthlyRule is false for every paid and unmetered shape", () => {
    expect(spentUnderOldMonthlyRule(quota({ limit: 100, used: 100, monthUsed: 1 }))).toBe(false);
    expect(spentUnderOldMonthlyRule(quota({ reason: "self-host", limit: null, plan: null }))).toBe(false);
    expect(spentUnderOldMonthlyRule(freeTier(2))).toBe(false);
  });
});
