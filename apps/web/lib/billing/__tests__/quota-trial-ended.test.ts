import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * After a trial, the free drafts are gone (assessment 2026-10-25).
 *
 * A trial cancelled before its first charge stops drafting at the cancel
 * (#260), and the cancellation email says nothing new is drafted. When the
 * trial then ended the account dropped to the free tier, whose seven lifetime
 * drafts the trial week had not used, and cron/generate wrote them at the
 * paid pace. The same door opened for a trial whose end webhook never came
 * and one whose first charge failed. `getQuota` is the one place the
 * allowance is decided, so the account row goes through it here and the
 * answer through the real spend gate.
 */

vi.mock("@/lib/billing/account-client", () => ({ accountCountingClient: (c: unknown) => c }));
vi.mock("@/lib/billing/operator-account", () => ({ accountHasOperator: async () => false }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/auth/preview", () => ({ inCustomerPreview: async () => false, customerPreviewPlan: async () => undefined }));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_quota_trial_ended";
});

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** An account row, two articles written, and a site that is not paused. */
function client(account: Record<string, unknown>) {
  const chain = (name: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "neq", "gte", "lt", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () =>
      name === "accounts"
        ? { data: account, error: null }
        : { data: { account_id: "acc", status: "active", paused_until: null }, error: null };
    q.single = q.maybeSingle;
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve(name === "workspaces" ? { data: [{ id: "w1" }], count: 1, error: null } : { data: [], count: 2, error: null });
    return q;
  };
  return { from: (n: string) => chain(n) } as never;
}

describe("an account that has had its trial has no free drafts", () => {
  it("a cancelled trial that has ended: nothing to draft, and the refusal says the plan is gone", async () => {
    const { getQuota, quotaExceededMessage, PLAN_ENDED_MESSAGE } = await import("../quota");
    const { canSpend } = await import("../spend-gate");
    const db = client({ plan: "starter", plan_status: "canceled", trial_ends_at: ago(2), free_drafts_used: 1 });

    const q = await getQuota(db, "acc", null);
    expect(q).toMatchObject({ reason: "no-plan", remaining: 0, trialEnded: true });
    expect(quotaExceededMessage(q)).toBe(PLAN_ENDED_MESSAGE);

    const scheduled = await canSpend(db, "acc", { userEmail: null, workspaceId: "w1", action: "scheduled-work" });
    expect(scheduled).toMatchObject({ allowed: false, reason: "no-plan" });
    expect(scheduled.message).toMatch(/none on this account any more/);
    const draft = await canSpend(db, "acc", { userEmail: null, workspaceId: "w1", action: "draft" });
    expect(draft).toMatchObject({ allowed: false, message: PLAN_ENDED_MESSAGE });
  });

  it("a trial whose end webhook never arrived: no longer a plan, and no free drafts either", async () => {
    const { getQuota } = await import("../quota");
    const db = client({ plan: "starter", plan_status: "trialing", trial_ends_at: ago(3), free_drafts_used: 1 });
    const q = await getQuota(db, "acc", null);
    expect(q).toMatchObject({ reason: "no-plan", remaining: 0, trialEnded: true });
    expect(q.trial).toBeUndefined();
  });

  it("a trial still running is the paid plan it was", async () => {
    const { getQuota } = await import("../quota");
    const db = client({ plan: "starter", plan_status: "trialing", trial_ends_at: new Date(Date.now() + 3 * DAY).toISOString() });
    expect(await getQuota(db, "acc", null)).toMatchObject({ reason: "plan", plan: "starter" });
  });

  it("a failed first charge: past due with no grace, refused as the card it is", async () => {
    const { getQuota } = await import("../quota");
    const { canSpend } = await import("../spend-gate");
    const trialEnd = ago(1);
    const db = client({
      plan: "starter",
      plan_status: "past_due",
      trial_ends_at: trialEnd,
      payment_failed_at: new Date(Date.parse(trialEnd) + 60 * 60 * 1000).toISOString(),
      free_drafts_used: 1,
    });
    const q = await getQuota(db, "acc", null);
    expect(q).toMatchObject({ reason: "no-plan", remaining: 0, dunning: { state: "lapsed", firstCharge: true } });

    const d = await canSpend(db, "acc", { userEmail: null, workspaceId: "w1", action: "scheduled-work" });
    expect(d).toMatchObject({ allowed: false, reason: "past-due" });
    expect(d.message).toMatch(/first payment after the trial did not go through/);
  });

  it("an account that never had a trial keeps its one-time free drafts", async () => {
    const { getQuota } = await import("../quota");
    const db = client({ plan: "starter", plan_status: "inactive", trial_ends_at: null, free_drafts_used: 0, stripe_subscription_id: "sub_x" });
    const q = await getQuota(db, "acc", null);
    expect(q).toMatchObject({ reason: "no-plan", remaining: 5 });
    expect(q.trialEnded).toBeUndefined();
  });
});
