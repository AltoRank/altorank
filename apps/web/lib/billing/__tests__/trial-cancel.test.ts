import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Quota } from "../quota";

// ---------------------------------------------------------------------------
// A trial cancelled before its first charge drafts nothing more
// ---------------------------------------------------------------------------
//
// Cancelling during the trial keeps the subscription `trialing` until its last
// day, and every drafting door read that as a paid plan: a person who
// cancelled on day two was drafted the rest of the week (assessment
// 2026-09-29). The rule is one predicate (lib/billing/trial-hold.ts,
// trialCancelledReason); this pins which accounts it stops, that the spend
// gate stops only the drafting actions with it, and that a paid plan set to
// cancel at period end keeps drafting.

const getQuota = vi.fn<(...args: unknown[]) => Promise<Quota>>();
vi.mock("@/lib/billing/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../quota")>();
  return { ...actual, getQuota: (...args: unknown[]) => getQuota(...args) };
});
const firstDraftAwaitsReview = vi.fn(async () => null as string | null);
vi.mock("@/lib/billing/first-draft-gate", () => ({ firstDraftAwaitsReview: () => firstDraftAwaitsReview() }));

const { canSpend } = await import("../spend-gate");
const { draftBlocker, draftHoldReason, trialCancelledBeforeCharge, trialCancelledReason } = await import("../trial-hold");
const { trialCancelledMessage, TRIAL_HOLD_MESSAGE } = await import("../trial-refusal");
const { trialInfo } = await import("../trial");

const TRIAL_END = "2026-10-06T12:00:00.000Z";

/** A trialing plan; `cancelsAt` is what the webhook wrote to accounts.cancels_at. */
const trialing = (cancelsAt: string | null): Quota => ({
  limit: 100,
  used: 5,
  remaining: 95,
  reason: "plan",
  plan: "starter",
  trial: { endsAt: TRIAL_END, daysLeft: 5, cancelsAt },
});

/** A paid plan set to cancel at the end of the period it paid for: no trial. */
const paidEnding: Quota = { limit: 100, used: 40, remaining: 60, reason: "plan", plan: "starter", trial: null };

function client(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { account_id: "acc", status: "active", paused_until: null }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  getQuota.mockReset();
  firstDraftAwaitsReview.mockClear();
});

describe("trialCancelledBeforeCharge", () => {
  it("is a trial set to end at its own end: Stripe cancels at the period end, which during a trial is the trial end", () => {
    expect(trialCancelledBeforeCharge(trialing(TRIAL_END))).toBe(true);
    // PostgREST's rendering of the same instant.
    expect(trialCancelledBeforeCharge(trialing("2026-10-06T12:00:00+00:00"))).toBe(true);
  });

  it("is not a trial that converts", () => {
    expect(trialCancelledBeforeCharge(trialing(null))).toBe(false);
  });

  it("is not a trial scheduled to end after its first charge: that one is paid for first", () => {
    expect(trialCancelledBeforeCharge(trialing("2026-11-06T12:00:00.000Z"))).toBe(false);
  });

  it("is never a paid plan set to cancel at period end", () => {
    expect(trialCancelledBeforeCharge(paidEnding)).toBe(false);
  });

  it("is never an account without a plan, self-host or operator", () => {
    for (const reason of ["no-plan", "self-host", "operator"] as const) {
      expect(trialCancelledBeforeCharge({ ...trialing(TRIAL_END), reason })).toBe(false);
    }
  });

  it("reads the cancellation off the account row the quota reads", () => {
    const info = trialInfo({ plan_status: "trialing", trial_ends_at: TRIAL_END, cancels_at: TRIAL_END }, new Date("2026-10-01T00:00:00Z"));
    expect(info?.cancelsAt).toBe(TRIAL_END);
    expect(trialCancelledBeforeCharge({ reason: "plan", trial: info })).toBe(true);
  });
});

describe("trialCancelledReason and draftHoldReason", () => {
  it("say what stopped, what stays readable and until when, and how to undo it", () => {
    const msg = trialCancelledReason(trialing(TRIAL_END));
    expect(msg).toBe(trialCancelledMessage(TRIAL_END));
    expect(msg).toMatch(/^Your trial is cancelled, so nothing new is drafted\./);
    expect(msg).toContain("October 6");
    expect(msg).toContain("nothing is charged");
    expect(msg).toContain("Keep my plan");
  });

  it("refuses whatever the call would add: a regeneration is bought as a new article is", () => {
    expect(draftHoldReason(trialing(TRIAL_END), { adding: 0 })).toBe(trialCancelledMessage(TRIAL_END));
    expect(draftHoldReason(trialing(TRIAL_END), { adding: 1 })).toBe(trialCancelledMessage(TRIAL_END));
  });

  it("lets a converting trial and a paid plan set to end draft on", () => {
    expect(draftHoldReason(trialing(null))).toBeNull();
    expect(draftHoldReason(paidEnding)).toBeNull();
  });

  it("still answers the pre-trial hold first for a gated account", () => {
    expect(draftHoldReason({ reason: "no-plan", trialEligible: true, used: 1 })).toBe(TRIAL_HOLD_MESSAGE);
  });
});

describe("draftBlocker: the crons' question", () => {
  it("stops the scheduled writer for a cancelled trial, before the first-draft rule is read", async () => {
    expect(await draftBlocker(client(), trialing(TRIAL_END), "ws")).toBe(trialCancelledMessage(TRIAL_END));
    expect(firstDraftAwaitsReview).not.toHaveBeenCalled();
  });

  it("lets a paid plan set to end keep its scheduled pace", async () => {
    expect(await draftBlocker(client(), paidEnding, "ws")).toBeNull();
    expect(await draftBlocker(client(), trialing(null), "ws")).toBeNull();
  });
});

describe("canSpend after a trial cancel", () => {
  it("refuses every drafting action: the week's burst and the scheduled writer, the editor's rewrites, scheduled rewrites", async () => {
    getQuota.mockResolvedValue(trialing(TRIAL_END));
    for (const action of ["scheduled-work", "draft", "refresh"] as const) {
      expect(await canSpend(client(), "acc", { userEmail: null, workspaceId: "ws", action })).toMatchObject({
        allowed: false,
        reason: "trial-cancelled",
        message: trialCancelledMessage(TRIAL_END),
      });
    }
  });

  it("leaves the rest open to the trial's end: the cancellation stops drafting, not the account", async () => {
    getQuota.mockResolvedValue(trialing(TRIAL_END));
    for (const action of ["keyword-research", "site-audit", "serp-lookup"] as const) {
      expect(await canSpend(client(), "acc", { userEmail: null, workspaceId: "ws", action })).toMatchObject({ allowed: true, reason: "plan" });
    }
  });

  it("keeps a paid plan set to cancel at period end drafting until that end", async () => {
    getQuota.mockResolvedValue(paidEnding);
    for (const action of ["scheduled-work", "draft", "refresh"] as const) {
      expect(await canSpend(client(), "acc", { userEmail: null, workspaceId: "ws", action })).toMatchObject({ allowed: true, reason: "plan" });
    }
  });

  it("opens again once the cancellation is undone (Keep my plan clears cancels_at)", async () => {
    getQuota.mockResolvedValue(trialing(null));
    expect(await canSpend(client(), "acc", { userEmail: null, workspaceId: "ws", action: "scheduled-work" })).toMatchObject({ allowed: true });
  });
});
