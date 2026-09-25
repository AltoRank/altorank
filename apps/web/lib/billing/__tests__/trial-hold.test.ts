import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The trial hold: one predicate, asked by every drafting door and by the
 * planner. What is pinned here is which accounts it holds and how many drafts
 * it lets a held account end up with - one, the onboarding's article.
 */

const { billing, getQuota, firstDraftAwaitsReview } = vi.hoisted(() => ({
  billing: { enabled: true },
  getQuota: vi.fn(),
  firstDraftAwaitsReview: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  get billingEnabled() {
    return billing.enabled;
  },
  TRIAL_DAYS: 7,
}));
vi.mock("@/lib/billing/quota", () => ({ getQuota: (...a: unknown[]) => getQuota(...a) }));
vi.mock("@/lib/billing/first-draft-gate", () => ({ firstDraftAwaitsReview: (...a: unknown[]) => firstDraftAwaitsReview(...a) }));
// The counting client is the service role in production; here it is the
// fake handed in, so the reads below are the ones asserted.
vi.mock("@/lib/billing/account-client", () => ({ accountCountingClient: (c: unknown) => c }));

import {
  draftBlocker,
  planHoldApplies,
  PRE_TRIAL_DRAFTS,
  TRIAL_HOLD_MESSAGE,
  TrialHoldError,
  trialHoldReason,
} from "../trial-hold";

const gated = (used: number) => ({ reason: "no-plan" as const, trialEligible: true, used });

beforeEach(() => {
  billing.enabled = true;
  delete process.env.TRIAL_GATE_DISABLED;
  getQuota.mockReset();
  firstDraftAwaitsReview.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.TRIAL_GATE_DISABLED;
});

describe("trialHoldReason", () => {
  it("lets a gated account write its one first article", () => {
    expect(PRE_TRIAL_DRAFTS).toBe(1);
    expect(trialHoldReason(gated(0))).toBeNull();
  });

  it("holds the second draft of a gated account, in words that name the trial", () => {
    expect(trialHoldReason(gated(1))).toBe(TRIAL_HOLD_MESSAGE);
    expect(TRIAL_HOLD_MESSAGE).toMatch(/^Waiting for your trial to start\./);
    expect(TRIAL_HOLD_MESSAGE).toContain("7-day trial");
    // The seven free drafts are not a pre-trial budget for these accounts.
    expect(trialHoldReason(gated(3))).toBe(TRIAL_HOLD_MESSAGE);
  });

  it("counts what the call adds: a row already inserted, or an article already counted, adds nothing", () => {
    // After its own insert, the first draft sees used = 1 and is still the one.
    expect(trialHoldReason(gated(1), { adding: 0 })).toBeNull();
    // Two racing first drafts each see the other's row: both over the line.
    expect(trialHoldReason(gated(2), { adding: 0 })).toBe(TRIAL_HOLD_MESSAGE);
  });

  // Each of these would lock a working account out of writing if it
  // regressed, so each is named rather than folded into one case.
  it("never holds a paying or trialing account", () => {
    expect(trialHoldReason({ reason: "plan", used: 40 })).toBeNull();
  });
  it("never holds a self-hosted install", () => {
    expect(trialHoldReason({ reason: "self-host", trialEligible: true, used: 40 })).toBeNull();
  });
  it("never holds an operator account", () => {
    expect(trialHoldReason({ reason: "operator", trialEligible: true, used: 40 })).toBeNull();
  });
  it("never holds an account that already had its trial: the older first-draft rule is its rule", () => {
    expect(trialHoldReason({ reason: "no-plan", trialEligible: false, used: 3 })).toBeNull();
  });
  it("is off with the gate's own kill switch", () => {
    process.env.TRIAL_GATE_DISABLED = "1";
    expect(trialHoldReason(gated(3))).toBeNull();
  });

  it("is an error of its own, so a cron can report it as a skip", () => {
    const err = new TrialHoldError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TrialHoldError");
    expect(err.message).toBe(TRIAL_HOLD_MESSAGE);
  });
});

describe("draftBlocker: the one question an unattended run asks", () => {
  const supabase = {} as never;

  it("holds a gated account at its first article, without asking the first-draft rule", async () => {
    expect(await draftBlocker(supabase, gated(1), "ws-1")).toBe(TRIAL_HOLD_MESSAGE);
    expect(firstDraftAwaitsReview).not.toHaveBeenCalled();
  });

  it("lets a gated account's first article through, and does not ask it to be read first", async () => {
    firstDraftAwaitsReview.mockResolvedValue("would block");
    expect(await draftBlocker(supabase, gated(0), "ws-1")).toBeNull();
    expect(firstDraftAwaitsReview).not.toHaveBeenCalled();
  });

  it("keeps the first-draft rule for a no-plan account that is not trial-gated", async () => {
    firstDraftAwaitsReview.mockResolvedValue("Your first draft is waiting for your review.");
    expect(await draftBlocker(supabase, { reason: "no-plan", trialEligible: false, used: 1 }, "ws-1")).toBe(
      "Your first draft is waiting for your review.",
    );
    expect(firstDraftAwaitsReview).toHaveBeenCalledWith(supabase, "ws-1");
  });

  it("keeps it for every no-plan account while the kill switch is on", async () => {
    process.env.TRIAL_GATE_DISABLED = "1";
    firstDraftAwaitsReview.mockResolvedValue("Your first draft is waiting for your review.");
    expect(await draftBlocker(supabase, gated(1), "ws-1")).toBe("Your first draft is waiting for your review.");
  });

  it("asks nothing of a paying account", async () => {
    expect(await draftBlocker(supabase, { reason: "plan", used: 9 }, "ws-1")).toBeNull();
    expect(firstDraftAwaitsReview).not.toHaveBeenCalled();
  });
});

describe("planHoldApplies: the planner's question, about the account", () => {
  function client(row: { account_id?: string } | null, error: { message: string } | null = null) {
    const reads: string[] = [];
    const c = {
      from: (table: string) => {
        reads.push(table);
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error }) };
        return q;
      },
    };
    return { c: c as never, reads };
  }

  it("reads nothing on a self-hosted install: there is no trial to wait for", async () => {
    billing.enabled = false;
    const { c, reads } = client({ account_id: "acc-1" });
    expect(await planHoldApplies(c, "ws-1")).toBe(false);
    expect(reads).toEqual([]);
    expect(getQuota).not.toHaveBeenCalled();
  });

  it("holds a gated account, reading the quota as nobody's session so the cron and a person agree", async () => {
    getQuota.mockResolvedValue(gated(0));
    const { c } = client({ account_id: "acc-1" });
    expect(await planHoldApplies(c, "ws-1")).toBe(true);
    expect(getQuota).toHaveBeenCalledWith(c, "acc-1", null);
  });

  it("does not hold a trialing account, an operator, or one with the kill switch on", async () => {
    getQuota.mockResolvedValue({ reason: "plan", used: 1 });
    expect(await planHoldApplies(client({ account_id: "acc-1" }).c, "ws-1")).toBe(false);
    getQuota.mockResolvedValue({ reason: "operator", used: 1, trialEligible: true });
    expect(await planHoldApplies(client({ account_id: "acc-1" }).c, "ws-1")).toBe(false);
    process.env.TRIAL_GATE_DISABLED = "1";
    getQuota.mockResolvedValue(gated(0));
    expect(await planHoldApplies(client({ account_id: "acc-1" }).c, "ws-1")).toBe(false);
  });

  it("throws on a read it could not make, rather than planning a month for an account it could not see", async () => {
    await expect(planHoldApplies(client(null, { message: "timeout" }).c, "ws-1")).rejects.toThrow(/could not read/);
    await expect(planHoldApplies(client(null).c, "ws-1")).rejects.toThrow(/no account/);
  });
});
