import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// A schedule nobody can run must not be armable
// ---------------------------------------------------------------------------
//
// cron/refresh gates on entitledToScheduledWork, so a no-plan account that
// flips this switch on gets a settings page reading "Rewrites on Tue and Thu"
// and a cron that skips it every morning. Before the gate it was worse than
// inert: the cron paid Anthropic for the rewrite brief before anything checked
// a plan. Both halves are the same fix, and this is the half that keeps the
// refusal readable instead of silent.
//
// Off is never refused. A plan that lapses must not leave a switch stuck on.

const updated = vi.fn();
let updateError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      update: (row: unknown) => {
        updated(row);
        return { eq: () => ({ eq: async () => ({ error: updateError }) }) };
      },
    }),
  }),
}));

const { requireAuth } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ accountId: "account-1", role: "owner", user: { id: "u1", email: "a@b.co" } })),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));

const { needsPlanToShip } = vi.hoisted(() => ({ needsPlanToShip: vi.fn(async () => false) }));
vi.mock("@/lib/billing/quota", async () => {
  const real = await vi.importActual<typeof import("@/lib/billing/quota")>("@/lib/billing/quota");
  return { ...real, needsPlanToShip };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { setRefreshSettings } = await import("../refresh");
const { SCHEDULED_REWRITES_NEED_PLAN } = await import("@/lib/billing/quota");

beforeEach(() => {
  updated.mockClear();
  updateError = null;
  needsPlanToShip.mockResolvedValue(false);
});

describe("setRefreshSettings", () => {
  it("refuses to arm the schedule without a plan, and says why", async () => {
    needsPlanToShip.mockResolvedValue(true);
    await expect(setRefreshSettings("ws1", { enabled: true, days: [2] })).rejects.toThrow(
      SCHEDULED_REWRITES_NEED_PLAN,
    );
    // The refusal is a refusal: nothing was written, so the switch does not
    // read "on" against a cron that will never act on it.
    expect(updated).not.toHaveBeenCalled();
  });

  it("names the Billing page rather than only saying no", () => {
    expect(SCHEDULED_REWRITES_NEED_PLAN).toMatch(/Billing/);
  });

  it("still lets a lapsed account switch its schedule off", async () => {
    needsPlanToShip.mockResolvedValue(true);
    await setRefreshSettings("ws1", { enabled: false, days: [2] });
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ refresh_enabled: false }));
  });

  it("arms the schedule for a paying account", async () => {
    await setRefreshSettings("ws1", { enabled: true, days: [4, 2] });
    expect(updated).toHaveBeenCalledWith({ refresh_enabled: true, refresh_days: [2, 4] });
  });
});
