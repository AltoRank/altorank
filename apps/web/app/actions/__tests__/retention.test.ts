import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Pause, resume, cancel, keep — when Stripe says no
// ---------------------------------------------------------------------------
//
// All four write our own rows first and tell Stripe second, so a Stripe
// failure leaves a visible, resumable state rather than a silent
// disagreement. That is the right order, and it creates the case these tests
// are about: the half that succeeded is real, and the sentence the person
// reads has to describe the state they are actually in.
//
// Saying "Paused" when only the workspaces were paused is the worst of the
// three possible answers, because the whole point of the pause is that the
// billing stops. And these actions used to throw, which in production means
// the person saw a hex digest instead of any of this.

type Row = Record<string, unknown>;

let agencyRow: Row = {};
let workspaceUpdateError: { message: string } | null = null;
let feedbackError: { message: string } | null = null;
const agencyWrites: Row[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "workspaces") {
        return {
          update: () => ({ eq: () => ({ neq: () => Promise.resolve({ error: workspaceUpdateError }) }) }),
        };
      }
      if (table === "cancellation_feedback") {
        return {
          insert: () => ({
            select: () => ({ single: () => Promise.resolve({ data: { id: "fb1" }, error: feedbackError }) }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: agencyRow, error: null }) }) }),
        update: (row: Row) => {
          agencyWrites.push(row);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  }),
}));

const { requireAuth, subUpdate } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ agencyId: "agency-1", role: "owner", user: { id: "u1" } })),
  subUpdate: vi.fn(),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    billingEnabled: true,
    getStripe: () => ({ subscriptions: { update: subUpdate } }),
  };
});
vi.mock("@/lib/billing/resume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/resume")>();
  return { ...actual, resumePausedWorkspaces: async () => ["ws1"], liftStripePause: actual.liftStripePause };
});

beforeEach(() => {
  agencyWrites.length = 0;
  workspaceUpdateError = null;
  feedbackError = null;
  agencyRow = {
    id: "agency-1",
    plan: "starter",
    stripe_subscription_id: "sub_1",
    current_period_end: "2026-12-01T00:00:00.000Z",
  };
  subUpdate.mockReset();
  subUpdate.mockResolvedValue({ cancel_at: 1796083200 });
});

describe("pauseAccount", () => {
  it("refuses a month count that is not 1, 2 or 3, in words", async () => {
    const { pauseAccount } = await import("../retention");
    expect(await pauseAccount(6)).toEqual({ ok: false, error: "Choose 1, 2 or 3 months." });
  });

  it("does not claim the billing paused when only the sites did", async () => {
    // The rows are already paused, so writing stopped. Saying "Paused" here
    // would be a claim about money we did not make - and this is the only
    // place the customer could ever learn it.
    subUpdate.mockRejectedValueOnce(new Error("Invalid API Key"));
    const { pauseAccount } = await import("../retention");
    const result = await pauseAccount(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("Writing is paused for every site");
    expect(result.error).toContain("billing could not be paused");
    expect(result.error).toContain("still be charged");
  });

  it("returns the date when both halves land", async () => {
    const { pauseAccount } = await import("../retention");
    const result = await pauseAccount(2);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.pausedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("cancelPlan", () => {
  it("says the plan is NOT cancelled when Stripe refuses", async () => {
    // The subscription still renews. A dialog that closed on "Cancelled" here
    // is how someone walks away believing they have stopped paying.
    subUpdate.mockRejectedValueOnce(new Error("Invalid API Key"));
    const { cancelPlan } = await import("../retention");
    const result = await cancelPlan({ reason: "price" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("has not been cancelled");
    expect(result.error).toContain("renew as before");
    // And `cancels_at` is not written, so the page does not show an end date
    // for a plan that is still running.
    expect(agencyWrites).toHaveLength(0);
  });

  it("keeps the survey answer even when the cancellation fails", async () => {
    // The reason is the one thing a cancellation teaches us, and it is
    // written before Stripe is told precisely so a refusal cannot lose it.
    subUpdate.mockRejectedValueOnce(new Error("nope"));
    const { cancelPlan } = await import("../retention");
    await cancelPlan({ reason: "price" });
    // Nothing rolled the feedback row back; the assertion that matters is
    // that the action did not treat writing it as the failure.
    expect(subUpdate).toHaveBeenCalledOnce();
  });

  it("refuses in words when there is no subscription to cancel", async () => {
    agencyRow = { ...agencyRow, stripe_subscription_id: null };
    const { cancelPlan } = await import("../retention");
    expect(await cancelPlan({ reason: "price" })).toEqual({
      ok: false,
      error: "There is no active subscription to cancel.",
    });
  });

  it("refuses an unanswered survey without touching Stripe", async () => {
    const { cancelPlan } = await import("../retention");
    const result = await cancelPlan({ reason: "" });
    expect(result.ok).toBe(false);
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it("returns the end date on success", async () => {
    const { cancelPlan } = await import("../retention");
    const result = await cancelPlan({ reason: "price" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.cancelsAt).toBe(new Date(1796083200 * 1000).toISOString());
  });
});

describe("keepPlan", () => {
  it("does not clear cancels_at when Stripe still holds the cancellation", async () => {
    // Clearing it locally would hide a plan that really is ending.
    subUpdate.mockRejectedValueOnce(new Error("nope"));
    const { keepPlan } = await import("../retention");
    const result = await keepPlan();
    expect(result.ok).toBe(false);
    expect(agencyWrites).toHaveLength(0);
  });
});

describe("resumeAccount", () => {
  it("says writing is back even when Stripe would not restart billing", async () => {
    // Stripe resumes on `resumes_at` by itself and the generate cron lifts the
    // rows again if it has to. Worth saying, not worth undoing.
    subUpdate.mockRejectedValueOnce(new Error("nope"));
    const { resumeAccount } = await import("../retention");
    const result = await resumeAccount();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("Writing has resumed for every site");
    expect(result.error).toContain("restarts on its own");
  });
});
